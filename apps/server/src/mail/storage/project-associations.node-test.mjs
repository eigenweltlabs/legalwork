import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { MailRepository } from './repository.js';
import { MailProjectAssociations } from './project-associations.js';
import { quarantineRestoredMail } from './recovery-quarantine.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';
import { LocalMailService } from '../service.js';

const project = { id: 'project-one', binding: 'a'.repeat(64) }, second = { id: 'project-two', binding: 'b'.repeat(64) };
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mail-project-')), path = join(dir, 'mail.sqlite'), key = randomBytes(32), db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db);
    const repo = new MailRepository(db, 'owner'), locator = { provider: 'gmail', messageId: 'one' };
    for (const id of ['a', 'b']) { repo.createAccount({ id, provider: 'gmail', displayName: id }); repo.putFolder(id, { id: 'INBOX', name: 'Inbox', kind: 'label' }); repo.ingestMessage(id, { locator, subject: 'Synthetic subject', rfcMessageId: null, memberships: ['INBOX'] }); }
    await run({ db, path, key, repo, locator, store: new MailProjectAssociations(db, 'owner', () => 1000) });
  } finally { db.close(); key.fill(0); await rm(dir, { recursive: true, force: true }); }
}

test('manual association, correction and clear preserve messages and never enqueue provider or filing actions', () => fixture(async f => {
  const messages = f.db.all('SELECT * FROM mail_messages'), memberships = f.db.all('SELECT * FROM mail_memberships');
  assert.equal(f.store.read('a', f.locator).version, null);
  const assigned = f.store.set('a', { locator: f.locator, expected: null, project });
  const changed = f.store.set('a', { locator: f.locator, expected: assigned.version, project: second });
  const cleared = f.store.set('a', { locator: f.locator, expected: changed.version, project: null });
  assert.equal(cleared.project, null); assert.equal(cleared.version.revision, 3);
  assert.deepEqual(f.store.history('a', { locator: f.locator }).items.map(item => item.project), [null, second, project]);
  assert.deepEqual(f.db.all('SELECT * FROM mail_messages'), messages); assert.deepEqual(f.db.all('SELECT * FROM mail_memberships'), memberships);
  for (const table of ['mail_action_jobs', 'mail_matter_filings', 'mail_storage_saves', 'mail_local_drafts', 'mail_local_rules']) assert.equal(f.db.get(`SELECT count(*) n FROM ${table}`).n, 0);
}));

test('owner, account and provider identity stay isolated, including read-only imported mail', () => fixture(async f => {
  f.store.set('a', { locator: f.locator, expected: null, project });
  assert.equal(f.store.read('b', f.locator).project, null);
  assert.throws(() => new MailProjectAssociations(f.db, 'other').read('a', f.locator));
  assert.throws(() => f.store.set('a', { locator: { provider: 'graph', messageId: 'one' }, expected: null, project }));
  f.repo.createAccount({ id: 'archive', provider: 'archive', displayName: 'Synthetic archive' });
  const locator = { provider: 'archive', namespace: 'synthetic', entryId: 'one' };
  f.repo.ingestMessage('archive', { locator, subject: 'Synthetic import', rfcMessageId: null, memberships: [] });
  assert.deepEqual(f.store.set('archive', { locator, expected: null, project }).project, project);
}));

test('stale edits fail and repeated identical writes create no duplicate audit events', () => fixture(async f => {
  assert.equal(f.store.set('a', { locator: f.locator, expected: null, project: null }).version, null);
  const assigned = f.store.set('a', { locator: f.locator, expected: null, project });
  assert.deepEqual(f.store.set('a', { locator: f.locator, expected: assigned.version, project }), assigned);
  assert.equal(f.store.history('a', { locator: f.locator }).items.length, 1);
  assert.throws(() => f.store.set('a', { locator: f.locator, expected: null, project: null }), { code: 'conflict' });
  const corrected = f.store.set('a', { locator: f.locator, expected: assigned.version, project: second });
  assert.throws(() => f.store.set('a', { locator: f.locator, expected: assigned.version, project }), { code: 'conflict' });
  assert.equal(corrected.version.revision, 2);
}));

test('audit insertion failure rolls the association and revision back atomically', () => fixture(async f => {
  f.db.exec("CREATE TRIGGER reject_project_audit BEFORE INSERT ON mail_project_changes BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.throws(() => f.store.set('a', { locator: f.locator, expected: null, project }));
  assert.equal(f.store.read('a', f.locator).version, null); assert.equal(f.store.history('a', { locator: f.locator }).items.length, 0);
}));

test('history keyset pages stay bounded with equal timestamps and include the largest safe revision', () => fixture(async f => {
  let current = f.store.read('a', f.locator);
  for (let index = 0; index < 25; index++) current = f.store.set('a', { locator: f.locator, expected: current.version, project: index % 2 ? second : project });
  const first = f.store.history('a', { locator: f.locator }), rest = f.store.history('a', { locator: f.locator, beforeRevision: first.nextRevision });
  assert.equal(first.items.length, 20); assert.equal(rest.items.length, 5); assert.equal(rest.nextRevision, null);
  assert.equal(new Set([...first.items, ...rest.items].map(item => item.version.revision)).size, 25);
  f.db.run('UPDATE mail_project_associations SET revision=? WHERE account_id=?', [Number.MAX_SAFE_INTEGER - 1, 'a']);
  current = f.store.read('a', f.locator);
  current = f.store.set('a', { locator: f.locator, expected: current.version, project: second });
  assert.equal(f.store.history('a', { locator: f.locator }).items[0].version.revision, Number.MAX_SAFE_INTEGER);
  assert.throws(() => f.store.set('a', { locator: f.locator, expected: current.version, project: null }), { code: 'conflict' });
}));

test('removed source mail is unavailable and local purging cascades private associations and history', () => fixture(async f => {
  f.store.set('a', { locator: f.locator, expected: null, project });
  f.db.run('INSERT INTO mail_tombstones(account_id,message_key,reason,observed_at) VALUES(?,?,?,?)', ['a', JSON.stringify(['gmail', 'one']), 'removed', new Date(0).toISOString()]);
  assert.throws(() => f.store.read('a', f.locator), { code: 'not_found' });
  assert.throws(() => f.store.set('a', { locator: f.locator, expected: null, project: second }), { code: 'not_found' });
  f.db.run('DELETE FROM mail_messages WHERE account_id=?', ['a']);
  assert.equal(f.db.get('SELECT count(*) n FROM mail_project_associations').n, 0); assert.equal(f.db.get('SELECT count(*) n FROM mail_project_changes').n, 0);
}));

test('restore preserves annotations but invalidates an earlier manual edit version', () => fixture(async f => {
  const current = f.store.set('a', { locator: f.locator, expected: null, project });
  quarantineRestoredMail(f.db);
  const restored = f.store.read('a', f.locator);
  assert.deepEqual(restored.project, project); assert.notEqual(restored.version.generation, current.version.generation);
  assert.throws(() => f.store.set('a', { locator: f.locator, expected: current.version, project: second }), { code: 'conflict' });
  assert.deepEqual(f.store.history('a', { locator: f.locator }).items[0].project, project);
}));

test('schema38 upgrade rolls back wholly and private worker annotations survive lock and restart', () => fixture(async f => {
  removeLaterMailSchema(f.db, 37); f.db.run('UPDATE mail_schema_version SET version=37');
  const failing = { ...f.db, exec(sql) { f.db.exec(sql); if (sql.includes('CREATE TABLE mail_project_associations')) throw Error('synthetic migration failure'); } };
  assert.throws(() => migrateMailSchema(failing)); assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, 37);
  assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_project_associations'"), undefined);
  migrateMailSchema(f.db); assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
  const options = { ownerId: 'owner', databasePath: f.path, loadKey: async () => Buffer.from(f.key), executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)) };
  let service = new LocalMailService(options);
  try {
    await service.setLifecycleSuspended(true); await service.unlock();
    const assigned = await service.projectAssociation({ operation: 'mail.project.set', accountId: 'a', input: { locator: f.locator, expected: null, project } });
    assert.deepEqual(assigned.projectAssociation.project, project);
    await service.lock(); await assert.rejects(service.projectAssociation({ operation: 'mail.project.read', accountId: 'a', input: { locator: f.locator } }));
    await service.stop(); service = new LocalMailService(options); await service.setLifecycleSuspended(true); await service.unlock();
    assert.deepEqual((await service.projectAssociation({ operation: 'mail.project.read', accountId: 'a', input: { locator: f.locator } })).projectAssociation, assigned.projectAssociation);
    assert.equal((await service.projectAssociation({ operation: 'mail.project.history', accountId: 'a', input: { locator: f.locator } })).projectHistory.items.length, 1);
    let current = assigned.projectAssociation;
    for(let index=0;index<25;index++)current=(await service.projectAssociation({operation:'mail.project.set',accountId:'a',input:{locator:f.locator,expected:current.version,project:{id:String(index)+'\u0000'.repeat(4080),binding:project.binding}}})).projectAssociation;
    const revisions=[];let beforeRevision;
    do{
      const result=await service.projectAssociation({operation:'mail.project.history',accountId:'a',input:{locator:f.locator,...(beforeRevision?{beforeRevision}:{})}});
      assert.ok(Buffer.byteLength(JSON.stringify(result))<64*1024);assert.ok(result.projectHistory.items.length>0);assert.ok(result.projectHistory.items.length<20);
      revisions.push(...result.projectHistory.items.map(item=>item.version.revision));beforeRevision=result.projectHistory.nextRevision;
    }while(beforeRevision);
    assert.equal(revisions.length,26);assert.equal(new Set(revisions).size,26);assert.deepEqual(revisions,Array.from({length:26},(_,index)=>26-index));
  } finally { await service.stop(); }
}));
