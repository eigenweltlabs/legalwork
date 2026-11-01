import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { assertMailSchema } from './consistency.js';
import { MailRepository } from './repository.js';
import { MailInvitationRepliesStore } from './invitation-replies.js';
import { LocalMailService } from '../service.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';
import { validWorkerCommand, resultMatchesCommand, parseWorkerMessage } from '../runtime/protocol.js';

const eventKey = 'a'.repeat(64);
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-rsvp-')), key = randomBytes(32), path = join(directory, 'mail.sqlite');
  let db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db);
    new MailRepository(db, 'owner').createAccount({ id: 'mail', provider: 'gmail', displayName: 'Owner' });
    new MailRepository(db, 'owner').createAccount({ id: 'other-mail', provider: 'imap', displayName: 'Another mailbox' });
    new MailRepository(db, 'other-owner').createAccount({ id: 'foreign', provider: 'gmail', displayName: 'Other owner' });
    await fn({ db, path, key, reopen: async () => { db.close(); db = await openEncryptedMailDatabase({ path, key }); return db; } });
  } finally { db.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}

test('an uncertain RSVP blocks duplicate sends across mail accounts and encrypted database restarts', () => fixture(async f => {
  const store = new MailInvitationRepliesStore(f.db, 'owner'), attemptId = randomUUID();
  const first = store.execute('mail', { action: 'begin', key: eventKey, attemptId, response: 'accepted' });
  assert.equal(first.claimed, true); assert.equal(first.entry.state, 'uncertain');
  assert.equal(store.execute('other-mail', { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'declined' }).claimed, false);
  const reopened = new MailInvitationRepliesStore(await f.reopen(), 'owner');
  assert.equal(reopened.execute('mail', { action: 'read', key: eventKey }).entry.attemptId, attemptId);
  assert.equal(reopened.execute('mail', { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'accepted' }).claimed, false);
  assert.equal((await readFile(f.path)).includes(Buffer.from(attemptId)), false);
}));

test('only the matching attempt can settle a claim, and an observed response permits a fresh explicit decision', () => fixture(async f => {
  const store = new MailInvitationRepliesStore(f.db, 'owner'), attemptId = randomUUID();
  store.execute('mail', { action: 'begin', key: eventKey, attemptId, response: 'tentative' });
  assert.throws(() => store.execute('mail', { action: 'finish', key: eventKey, attemptId: randomUUID(), state: 'confirmed' }));
  assert.equal(store.execute('mail', { action: 'finish', key: eventKey, attemptId, state: 'confirmed' }).entry.state, 'confirmed');
  assert.equal(store.execute('mail', { action: 'begin', key: eventKey, attemptId, response: 'tentative' }).claimed, false);
  assert.throws(() => store.execute('mail', { action: 'finish', key: eventKey, attemptId, state: 'rejected' }));
  const next = store.execute('other-mail', { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'declined' });
  assert.equal(next.claimed, true);
  assert.equal(store.execute('mail', { action: 'finish', key: eventKey, attemptId: next.entry.attemptId, state: 'rejected' }).entry.state, 'rejected');
}));

test('the same target hash is private to its owner and cannot be queried through another owner account', () => fixture(async f => {
  const owner = new MailInvitationRepliesStore(f.db, 'owner'), other = new MailInvitationRepliesStore(f.db, 'other-owner');
  owner.execute('mail', { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'accepted' });
  assert.throws(() => owner.execute('foreign', { action: 'read', key: eventKey }));
  assert.equal(other.execute('foreign', { action: 'read', key: eventKey }).entry, null);
  assert.equal(other.execute('foreign', { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'declined' }).claimed, true);
}));

test('v33 migration is additive, transactional and required by the startup guard', () => fixture(async f => {
  removeLaterMailSchema(f.db, 33); f.db.run('UPDATE mail_schema_version SET version=33');
  const broken = { ...f.db, exec(sql) { f.db.exec(sql); if (sql.includes('CREATE TABLE mail_invitation_replies')) throw Error('synthetic interrupted migration'); } };
  assert.throws(() => migrateMailSchema(broken));
  assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, 33);
  assert.equal(f.db.get("SELECT name FROM sqlite_master WHERE name='mail_invitation_replies'"), undefined);
  assert.throws(() => assertMailSchema(f.db));
  migrateMailSchema(f.db); assertMailSchema(f.db);
  assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
  assert.equal(f.db.get('SELECT count(*) n FROM mail_accounts').n, 3);
  assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), []);
}));

test('the actual Node worker persists claims through lock/unlock and rejects foreign account access', () => fixture(async f => {
  const service = new LocalMailService({ executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)), databasePath: f.path, ownerId: 'owner', loadKey: async () => Buffer.from(f.key) });
  const input = { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'accepted' };
  try {
    await assert.rejects(service.invitationJournal('mail', input), { message: 'mail_locked' });
    await service.unlock(); assert.equal((await service.invitationJournal('mail', input)).claimed, true);
    await service.lock(); await service.unlock();
    assert.equal((await service.invitationJournal('other-mail', { ...input, attemptId: randomUUID() })).claimed, false);
    await assert.rejects(service.invitationJournal('foreign', { action: 'read', key: eventKey }), { message: 'mail_not_found' });
  } finally { await service.stop(); }
}));

test('worker protocol bounds journal requests and fences substituted target or account results', () => {
  const command = { operation: 'mail.invitation.journal', accountId: 'mail', input: { action: 'begin', key: eventKey, attemptId: randomUUID(), response: 'accepted' } };
  assert.equal(validWorkerCommand(command), true);
  assert.equal(validWorkerCommand({ ...command, accessToken: 'forbidden' }), false);
  assert.equal(validWorkerCommand({ ...command, input: { ...command.input, key: 'url:provider' } }), false);
  const result = { invitationJournal: { accountId: 'mail', claimed: true, entry: { key: eventKey, attemptId: command.input.attemptId, response: 'accepted', state: 'uncertain', updatedAt: Date.now() } } };
  assert.equal(resultMatchesCommand(command, result), true);
  assert.equal(resultMatchesCommand(command, { invitationJournal: { ...result.invitationJournal, accountId: 'foreign' } }), false);
  assert.equal(resultMatchesCommand(command, { invitationJournal: { ...result.invitationJournal, entry: { ...result.invitationJournal.entry, key: 'b'.repeat(64) } } }), false);
  const finish = { ...command, input: { action: 'finish', key: eventKey, attemptId: command.input.attemptId, state: 'confirmed' } };
  assert.equal(resultMatchesCommand(finish, { invitationJournal: { ...result.invitationJournal, claimed: false, entry: { ...result.invitationJournal.entry, state: 'confirmed', attemptId: randomUUID() } } }), false);
  assert.equal(resultMatchesCommand(finish, { invitationJournal: { ...result.invitationJournal, claimed: false } }), false);
  assert.equal(parseWorkerMessage(JSON.stringify({ kind: 'response', id: '1:1', ok: true, result }))?.ok, true);
});
