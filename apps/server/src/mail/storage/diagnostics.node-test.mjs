import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { MailRepository } from './repository.js';
import { MailContentStore } from './content-store.js';
import { MailActionJournal } from './action-journal.js';
import { MailCredentialRepository } from './credentials.js';
import { SenderIdentityRepository } from './sender-identities.js';
import { OutboxStore } from './outbox.js';
import { collectMailDiagnostics } from './diagnostics.js';
import { mailDiagnosticsSchema, mailDiagnosticSnapshotSchema } from '../diagnostics-view.js';
import { LocalMailService } from '../service.js';
import { parseWorkerMessage, validWorkerCommand, resultMatchesCommand } from '../runtime/protocol.js';

async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), 'legalwork-mail-diagnostics-')), path = join(directory, 'mail.sqlite'), key = randomBytes(32);
  let db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db);
    await body({ db, path, key, directory, close() { db.close(); db = null; } });
  } finally { db?.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}
const locator = messageId => ({ provider: 'gmail', messageId });
const intent = (kind, replayKey) => ({ kind, replayKey, payloadJson: '{"private":"secret-document-text"}', precondition: null, conflictPolicy: 'manual' });
const emptyReport = snapshot => ({ format: 'legalwork-mail-diagnostics', version: 1, generatedAt: '2026-11-01T10:00:00.000Z', state: 'ready', snapshot });

test('empty encrypted store produces fixed zero counts and no account identity or content fields', async () => fixture(async ({ db }) => {
  const result = collectMailDiagnostics(db, 'owner', false, 1000);
  assert.equal(result.schemaVersion, MAIL_SCHEMA_VERSION);
  assert.equal(result.lifecycle, 'running');
  assert.deepEqual(result.accounts, { gmail: 0, graph: 0, imap: 0, archive: 0, retainedCopies: 0 });
  assert.deepEqual(result.messages, { total: 0, attachmentsEnumerated: 0 });
  assert.deepEqual(result.originals, { pending: 0, stored: 0, unavailable: 0 });
  assert.deepEqual(result.attachments, { pending: 0, stored: 0, unavailable: 0 });
  for (const group of ['syncJobs', 'mutations', 'submissions', 'drafts', 'schedules', 'search', 'invitationReplies']) {
    assert.ok(Object.values(result[group]).every(value => value === 0));
  }
  assert.ok(mailDiagnosticsSchema.safeParse(emptyReport(result)).success);
}));

test('counts are owner-scoped, preserve uncertain actions and never export private source values', async () => fixture(async ({ db }) => {
  const repository = new MailRepository(db, 'owner'), foreign = new MailRepository(db, 'other');
  for (const provider of ['gmail', 'graph', 'imap', 'archive']) repository.createAccount({ id: provider + '-private-account', provider, displayName: 'PRIVATE_DISPLAY_NAME' });
  foreign.createAccount({ id: 'foreign-private-account', provider: 'gmail', displayName: 'PRIVATE_FOREIGN_NAME' });
  const accountId = 'gmail-private-account', content = new MailContentStore(db, 'owner');
  for (const messageId of ['stored-private-id', 'unavailable-private-id', 'unknown-private-id']) repository.ingestMessage(accountId,
    { locator: locator(messageId), subject: 'PRIVATE_SUBJECT', rfcMessageId: '<private@example.invalid>', memberships: [] });
  foreign.ingestMessage('foreign-private-account', { locator: locator('foreign-private-id'), subject: 'FOREIGN_SUBJECT', rfcMessageId: null, memberships: [] });
  const raw = Buffer.from('From: private@example.invalid\r\nSubject: PRIVATE_SUBJECT\r\n\r\nPRIVATE_MAIL_BODY');
  await content.writePart(accountId, locator('stored-private-id'), { kind: 'raw', maxBytes: raw.length }, [raw]);
  await content.writePart(accountId, locator('stored-private-id'), { kind: 'attachment', partId: 'PRIVATE_FILENAME', maxBytes: 4 }, [Buffer.from('DATA')]);
  repository.putContent(accountId, locator('unavailable-private-id'), { kind: 'raw', state: 'unavailable' });
  repository.putContent(accountId, locator('unavailable-private-id'), { kind: 'attachment', partId: 'private-pending', state: 'pending' });
  repository.putContent(accountId, locator('unknown-private-id'), { kind: 'attachment', partId: 'private-missing', state: 'unavailable' });
  repository.setAttachmentsEnumerated(accountId, locator('stored-private-id'), true);
  db.run('INSERT OR IGNORE INTO mail_search_dirty(account_id,message_key) VALUES(?,?)', [accountId, JSON.stringify(['gmail', 'stored-private-id'])]);
  db.run('INSERT OR IGNORE INTO mail_search_dirty(account_id,message_key) VALUES(?,?)', ['foreign-private-account', JSON.stringify(['gmail', 'foreign-private-id'])]);
  const journal = new MailActionJournal(db, 'owner', () => 1000);
  const uncertain = journal.enqueue(accountId, intent('submission', 'private-uncertain-key'));
  const claimed = journal.claim(accountId); journal.markDispatched(claimed.lease); journal.recordOutcome(claimed.lease, 'unknown');
  journal.enqueue(accountId, intent('submission', 'private-queued-key'));
  journal.enqueue(accountId, intent('mutation', 'private-mutation-key'));
  new MailActionJournal(db, 'other', () => 1000).enqueue('foreign-private-account', intent('submission', 'foreign-queued-key'));
  db.run("INSERT INTO mail_invitation_replies VALUES(?,? ,?,'accepted','uncertain',1000)", ['owner', 'private-event-key', 'private-attempt']);
  db.run("INSERT INTO mail_invitation_replies VALUES(?,? ,?,'accepted','confirmed',1000)", ['other', 'foreign-event-key', 'foreign-attempt']);
  const changes = db.get('SELECT total_changes() AS value').value;
  const result = collectMailDiagnostics(db, 'owner', true, 1000);
  assert.equal(db.get('SELECT total_changes() AS value').value, changes);
  assert.deepEqual(result.accounts, { gmail: 1, graph: 1, imap: 1, archive: 1, retainedCopies: 0 });
  assert.deepEqual(result.messages, { total: 3, attachmentsEnumerated: 1 });
  assert.deepEqual(result.originals, { pending: 1, stored: 1, unavailable: 1 });
  assert.deepEqual(result.attachments, { pending: 1, stored: 1, unavailable: 1 });
  assert.equal(result.lifecycle, 'suspended');
  assert.equal(result.submissions.uncertain, 1); assert.equal(result.submissions.queued, 1); assert.equal(result.mutations.queued, 1);
  assert.equal(result.search.pending, 3); assert.equal(result.invitationReplies.uncertain, 1); assert.equal(result.invitationReplies.confirmed, 0);
  assert.equal(journal.read(accountId, uncertain.id).state, 'uncertain');
  const serialized = JSON.stringify(result);
  for (const marker of ['private', 'PRIVATE', 'FOREIGN', 'secret-document-text', 'example.invalid', 'DATA']) assert.equal(serialized.includes(marker), false);
  assert.deepEqual(collectMailDiagnostics(db, 'unrelated', false).accounts, { gmail: 0, graph: 0, imap: 0, archive: 0, retainedCopies: 0 });
}));

test('scheduled counts follow the durable queued state, due instant and cancellation without sending', async () => fixture(async ({ db }) => {
  new MailRepository(db, 'owner').createAccount({ id: 'gmail', provider: 'gmail', displayName: 'Synthetic' });
  const now = Date.now(), credentials = new MailCredentialRepository(db, 'owner');
  credentials.connect('gmail', { provider: 'gmail', clientId: 'fixture.apps.googleusercontent.com', authority: 'https://accounts.google.com', providerSubject: 'private-subject' }, null,
    { accessToken: 'PRIVATE_ACCESS_TOKEN', expiresAt: now + 3600000, grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'], refreshToken: { action: 'replace', value: 'PRIVATE_REFRESH_TOKEN' } });
  const identity = new SenderIdentityRepository(db, 'owner').replace('gmail', credentials.status('gmail').version.generation,
    [{ address: 'private@example.invalid', displayName: 'PRIVATE_NAME', primary: true, default: true }])[0];
  const store = new OutboxStore(db, 'owner', () => now);
  const draft = store.local.saveDraft('gmail', { draftId: randomUUID(), expected: null, content: { from: identity.address, senderIdentityId: identity.id,
    to: ['recipient@example.invalid'], subject: 'PRIVATE_DRAFT_SUBJECT', text: 'PRIVATE_DRAFT_BODY' } });
  const queued = await store.queue('gmail', { draftId: draft.id, version: draft.version, replayKey: randomUUID(), schedule: { at: now + 3600000, timeZone: 'Europe/Berlin' } });
  assert.deepEqual(collectMailDiagnostics(db, 'owner', false, now).schedules, { queued: 1, due: 0 });
  assert.deepEqual(collectMailDiagnostics(db, 'owner', false, now + 3600000).schedules, { queued: 1, due: 1 });
  assert.equal(collectMailDiagnostics(db, 'owner', false, now).drafts.active, 1);
  await store.cancel('gmail', queued.id);
  const report = collectMailDiagnostics(db, 'owner', false, now + 7200000);
  assert.deepEqual(report.schedules, { queued: 0, due: 0 });
  assert.equal(report.submissions.cancelled, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
}));

test('strict report and private protocol reject arbitrary data, owner overrides and mismatched results', async () => fixture(async ({ db }) => {
  const snapshot = collectMailDiagnostics(db, 'owner', false);
  assert.equal(validWorkerCommand({ operation: 'mail.diagnostics' }), true);
  for (const field of ['ownerId', 'accountId', 'sql', 'accessToken']) assert.equal(validWorkerCommand({ operation: 'mail.diagnostics', [field]: 'forbidden' }), false);
  assert.equal(resultMatchesCommand({ operation: 'mail.diagnostics' }, { diagnostics: snapshot }), true);
  assert.equal(resultMatchesCommand({ operation: 'mail.diagnostics' }, { pong: true }), false);
  const frame = { kind: 'response', id: '1:1', ok: true, result: { diagnostics: snapshot } };
  const validFrame = parseWorkerMessage(JSON.stringify(frame));
  assert.ok(validFrame);
  assert.equal(parseWorkerMessage(JSON.stringify({ ...frame, result: { diagnostics: { ...snapshot, accountId: 'private' } } })), undefined);
  assert.equal(mailDiagnosticSnapshotSchema.safeParse({ ...snapshot, accountId: 'private' }).success, false);
  assert.equal(mailDiagnosticSnapshotSchema.safeParse({ ...snapshot, submissions: { ...snapshot.submissions, error: 'private body' } }).success, false);
  assert.equal(mailDiagnosticsSchema.safeParse({ ...emptyReport(snapshot), state: 'locked' }).success, false);
  assert.equal(mailDiagnosticsSchema.safeParse({ ...emptyReport(snapshot), state: 'locked', snapshot: null }).success, true);
  assert.equal(mailDiagnosticsSchema.safeParse({ ...emptyReport(snapshot), token: 'private' }).success, false);
  assert.equal(mailDiagnosticsSchema.safeParse({ ...emptyReport(snapshot), snapshot: null }).success, false);
}));

test('real private worker reports local counts; locked/stopped diagnostics never open the vault or start a worker', async () => fixture(async ({ path, key, close }) => {
  close(); let keyLoads = 0;
  const service = new LocalMailService({ ownerId: 'owner', databasePath: path,
    executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)),
    loadKey: async () => { keyLoads++; return Buffer.from(key); } });
  try {
    assert.deepEqual((await service.diagnostics()).snapshot, null); assert.equal(keyLoads, 0);
    await service.unlock();
    const report = await service.diagnostics();
    assert.equal(report.state, 'ready'); assert.equal(report.snapshot.messages.total, 0);
    await service.setLifecycleSuspended(true);
    assert.equal((await service.diagnostics()).snapshot.lifecycle, 'suspended');
    await service.lock(); const afterLock = keyLoads;
    assert.equal((await service.diagnostics()).state, 'locked'); assert.equal(keyLoads, afterLock);
    await service.stop(); assert.equal((await service.diagnostics()).state, 'stopped'); assert.equal(keyLoads, afterLock);
  } finally { await service.stop(); }
}));
