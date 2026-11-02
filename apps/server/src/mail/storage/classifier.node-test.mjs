import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { MailRepository } from './repository.js';
import { MailContentStore } from './content-store.js';
import { MimeProjectionStore } from './mime-projection-store.js';
import { MailClassifierStore } from './classifier.js';
import { MailProjectAssociations } from './project-associations.js';
import { quarantineRestoredMail } from './recovery-quarantine.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';
import { LocalMailService } from '../service.js';
import { fileURLToPath } from 'node:url';

const project = { id: 'project-one', binding: 'a'.repeat(64) };
const definition = { mode: 'suggestions', rules: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Project reference', enabled: true, order: 1, project, criteria: { sender: 'client@example.test', domain: '', reference: 'MAT-123', subject: '' } }], exclusions: { senders: [], domains: [], subjects: [] } };
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mail-classifier-')), path = join(dir, 'mail.sqlite'), key = randomBytes(32), db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db); const repo = new MailRepository(db, 'owner'), store = new MailClassifierStore(db, 'owner', () => 1000), locator = { provider: 'gmail', messageId: 'one' };
    for (const account of ['a', 'b']) {
      repo.createAccount({ id: account, provider: 'gmail', displayName: account }); repo.ingestMessage(account, { locator, subject: 'Re: MAT-123', rfcMessageId: null, memberships: [] });
      const content = new MailContentStore(db, 'owner'), raw = await content.writePart(account, locator, { kind: 'raw', maxBytes: 1000 }, [Buffer.from('Subject: MAT-123\r\n\r\nSynthetic')]);
      const body = await content.writePart(account, locator, { kind: 'body', maxBytes: 1000 }, [Buffer.from('{"version":1,"bodies":[]}')]);
      new MimeProjectionStore(db, 'owner').complete(account, locator, raw.id, { metadata: { subject: 'Re: MAT-123', from: 'Client <client@example.test>', to: null, cc: null, bcc: null, replyTo: null, date: null, messageId: null }, bodies: [], body, attachments: [] });
    }
    await run({ db, path, key, repo, store, locator });
  } finally { db.close(); key.fill(0); await rm(dir, { recursive: true, force: true }); }
}

test('classifier settings are account/owner scoped, Off by default and versioned across updates', () => fixture(async f => {
  assert.equal(f.store.read('a').definition.mode, 'off'); assert.equal(f.store.read('a').version, null);
  const saved = f.store.save('a', { expected: null, definition }); assert.equal(saved.version.revision, 1);
  assert.equal(f.store.read('b').definition.mode, 'off'); assert.throws(() => new MailClassifierStore(f.db, 'other').read('a'), { code: 'not_found' });
  assert.throws(() => f.store.save('a', { expected: null, definition }), { code: 'conflict' });
  assert.throws(() => f.store.save('b', { expected: saved.version, definition }), { code: 'conflict' });
  const hidden = { ...definition, mode: 'off', rules: definition.rules.map(rule => ({ ...rule, project: null, enabled: false })) };
  const changed = f.store.save('a', { expected: saved.version, definition: hidden }); assert.deepEqual(changed.definition.rules[0].project, project); assert.equal(changed.version.revision, 2);
  assert.throws(() => f.store.save('b', { expected: null, definition: hidden }), { code: 'invalid_input' });
}));

test('on-demand suggestions never write messages, assignments, rules, drafts, provider actions or filing records', () => fixture(async f => {
  const before = f.db.all('SELECT * FROM mail_messages');
  assert.equal(f.store.preview('a', { locator: f.locator }).status, 'off');
  f.store.save('a', { expected: null, definition });
  const result = f.store.preview('a', { locator: f.locator }); assert.equal(result.status, 'suggested'); assert.deepEqual(result.candidates[0].project, project);
  assert.equal(f.store.preview('b', { locator: f.locator }).status, 'off');
  assert.throws(() => f.store.preview('a', { locator: { provider: 'graph', messageId: 'one' } }), { code: 'not_found' });
  for (const table of ['mail_project_associations', 'mail_project_changes', 'mail_action_jobs', 'mail_local_drafts', 'mail_matter_filings', 'mail_storage_saves', 'mail_local_rules', 'mail_rule_arrivals']) assert.equal(f.db.get(`SELECT count(*) n FROM ${table}`).n, 0);
  assert.deepEqual(f.db.all('SELECT * FROM mail_messages'), before);
}));

test('explicit assignment and a subsequent clear always take precedence over classifier suggestions', () => fixture(async f => {
  f.store.save('a', { expected: null, definition });
  const projects = new MailProjectAssociations(f.db, 'owner'), current = projects.set('a', { locator: f.locator, expected: null, project });
  assert.equal(f.store.preview('a', { locator: f.locator }).status, 'manual');
  projects.set('a', { locator: f.locator, expected: current.version, project: null }); assert.equal(f.store.preview('a', { locator: f.locator }).status, 'manual');
}));

test('restore preserves configured rules but turns classification Off and fences earlier edits', () => fixture(async f => {
  const saved = f.store.save('a', { expected: null, definition }); quarantineRestoredMail(f.db);
  const restored = f.store.read('a'); assert.equal(restored.definition.mode, 'off'); assert.deepEqual(restored.definition.rules, definition.rules); assert.notEqual(restored.version.generation, saved.version.generation);
  assert.throws(() => f.store.save('a', { expected: saved.version, definition }), { code: 'conflict' });
}));

test('schema39 migration is atomic and repeated opening preserves classifier configuration', () => fixture(async f => {
  removeLaterMailSchema(f.db, 38); f.db.run('UPDATE mail_schema_version SET version=38');
  const failing = { ...f.db, exec(sql) { f.db.exec(sql); if (sql.includes('CREATE TABLE mail_project_classifiers')) throw Error('synthetic migration failure'); } };
  assert.throws(() => migrateMailSchema(failing)); assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, 38); assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_project_classifiers'"), undefined);
  migrateMailSchema(f.db); assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
  const saved = f.store.save('a', { expected: null, definition }); migrateMailSchema(f.db); assert.deepEqual(new MailClassifierStore(f.db, 'owner').read('a'), saved);
}));

test('private classifier commands round-trip through actual encrypted Node workers and stay unavailable while locked', () => fixture(async f => {
  const options = { ownerId: 'owner', databasePath: f.path, loadKey: async () => Buffer.from(f.key), executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)) };
  let service = new LocalMailService(options);
  try {
    await service.setLifecycleSuspended(true); await service.unlock();
    const read = await service.classifier({ operation: 'mail.classifier.read', accountId: 'a' }); assert.equal(read.classifier.definition.mode, 'off');
    const saved = await service.classifier({ operation: 'mail.classifier.save', accountId: 'a', input: { expected: null, definition } }); assert.equal(saved.classifier.version.revision, 1);
    const checked = await service.classifier({ operation: 'mail.classifier.preview', accountId: 'a', input: { locator: f.locator } }); assert.equal(checked.classification.status, 'suggested');
    await service.lock(); await assert.rejects(service.classifier({ operation: 'mail.classifier.read', accountId: 'a' })); await service.stop();
    service = new LocalMailService(options); await service.setLifecycleSuspended(true); await service.unlock();
    assert.deepEqual((await service.classifier({ operation: 'mail.classifier.read', accountId: 'a' })).classifier, saved.classifier);
    assert.equal((await service.classifier({ operation: 'mail.classifier.preview', accountId: 'a', input: { locator: f.locator } })).classification.status, 'suggested');
  } finally { await service.stop(); }
}));
