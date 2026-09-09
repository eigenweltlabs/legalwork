/** Run via consistency.test.ts: actual encrypted Node integration after isolated TS compilation. */
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
import { assertMailSchema, checkMailConsistency } from './consistency.js';

const locator = messageId => ({ provider: 'gmail', messageId });
async function fixture(body, migrate = true) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-consistency-'));
  const path = join(directory, 'mail.sqlite'); const key = randomBytes(32);
  let db = await openEncryptedMailDatabase({ path, key });
  try {
    if (migrate) migrateMailSchema(db);
    await body({ db, repository: new MailRepository(db, 'owner'), store: new MailContentStore(db, 'owner'),
      async reopen() { db.close(); db = await openEncryptedMailDatabase({ path, key }); db.exec('PRAGMA foreign_keys=ON'); return db; } });
  } finally { db.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}
function seed(repository, messageId = 'one', createAccount = true) {
  if (createAccount) {
    repository.createAccount({ id: 'private-account', provider: 'gmail', displayName: 'Private account title' });
    repository.putFolder('private-account', { id: 'inbox', kind: 'label', name: 'Private folder title' });
  }
  repository.ingestMessage('private-account', { locator: locator(messageId), rfcMessageId: '<private@example.invalid>', subject: 'Secret matter details', memberships: ['inbox'] });
}
async function complete(store, repository) {
  await store.writePart('private-account', locator('one'), { kind: 'raw', maxBytes: 65536 }, [new Uint8Array(65536).fill(8)]);
  await store.writePart('private-account', locator('one'), { kind: 'body', maxBytes: 0 }, []);
  repository.setAttachmentsEnumerated('private-account', locator('one'), true);
}
function privateReport(result) {
  const serialized = JSON.stringify(result);
  for (const marker of ['private-account', 'Private account title', 'Secret matter details', 'private@example.invalid', 'one', 'raw']) {
    assert.ok(!serialized.includes(marker), `Diagnostic leaked ${marker}`);
  }
}

test('valid current-schema encrypted content survives reopen and shallow diagnostic returns only fixed codes/counts', async () => fixture(async ({ db, repository, store, reopen }) => {
  seed(repository); await complete(store, repository);
  const first = checkMailConsistency(db);
  assert.equal(first.ok, true); assert.equal(first.scanComplete, true); assert.equal(first.contentHashesVerified, false);
  assert.deepEqual(first.codes, []); assert.ok(first.scannedRows > 0); privateReport(first);
  const reopened = await reopen();
  assert.deepEqual(checkMailConsistency(reopened), first);
}));

test('v1 reopen requires upgrade; a failed current migration rolls back and never repairs legacy stored refs', async () => fixture(async ({ db, repository, reopen }) => {
  seed(repository);
  for (const kind of ['raw', 'body']) repository.putContent('private-account', locator('one'), { kind, state: 'stored', reference: { id: 'legacy-ref', bytes: 3, sha256: 'a'.repeat(64) } });
  repository.setAttachmentsEnumerated('private-account', locator('one'), true);
 db.exec("DROP TABLE mail_graph_attachments; DROP TABLE mail_graph_messages; DROP TABLE mail_graph_folder_queue; DROP TABLE mail_graph_runs");
 for(const row of db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_search_*'"))db.exec('DROP TRIGGER "'+row.name+'"');
 db.exec('DROP TABLE mail_search_fts; DROP TABLE mail_search_documents; DROP TABLE mail_search_dirty; ALTER TABLE mail_messages DROP COLUMN is_read');
  db.exec('DROP TRIGGER mail_raw_projection_insert; DROP TRIGGER mail_raw_projection_update; DROP TABLE mail_mime_parts; DROP TABLE mail_mime_projections; DROP TABLE mail_gmail_metadata; DROP TABLE mail_gmail_presence; DROP TABLE mail_gmail_runs; DROP TABLE mail_action_jobs; DROP TABLE mail_account_credentials; DROP TABLE mail_sync_scope_jobs; DROP TABLE mail_sync_jobs; DROP TABLE mail_sync_scopes; DROP TABLE mail_blob_publications; DROP TABLE mail_blob_chunks; DROP TABLE mail_blob_objects; UPDATE mail_schema_version SET version=1');
  let current = await reopen();
  assert.deepEqual(checkMailConsistency(current).codes, ['schema-upgrade-required']);
  const failing = { ...current, exec(sql) { current.exec(sql); if (sql.includes('CREATE TABLE mail_blob_objects')) throw new Error('migration failure'); } };
  assert.throws(() => migrateMailSchema(failing), /migration failure/);
  assert.equal(current.get('SELECT version FROM mail_schema_version').version, 1);
  assert.equal(current.get("SELECT name FROM sqlite_schema WHERE name='mail_blob_objects'"), undefined);
  current = await reopen();
  assert.deepEqual(checkMailConsistency(current).codes, ['schema-upgrade-required']);
  migrateMailSchema(current);
  const result = checkMailConsistency(current);
  assert.equal(result.ok, false); assert.equal(result.scanComplete, true);
  assert.ok(result.codes.includes('unpublished-content')); privateReport(result);
  assert.equal(current.get('SELECT count(*) AS count FROM mail_content_manifests WHERE ref_id=?', ['legacy-ref']).count, 2);
  assert.equal(current.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
}));

test('missing/newer/incomplete schema reports fixed codes without creating tables or downgrading', async () => {
  await fixture(async ({ db }) => {
    assert.deepEqual(checkMailConsistency(db).codes, ['schema-missing']);
    assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='mail_schema_version'"), undefined);
  }, false);
  await fixture(async ({ db, repository }) => {
    seed(repository);
    db.run('UPDATE mail_schema_version SET version=?', [MAIL_SCHEMA_VERSION + 1]);
    assert.deepEqual(checkMailConsistency(db).codes, ['unsupported-schema-version']);
    assert.throws(() => migrateMailSchema(db), /Unsupported mail schema version/);
    assert.equal(db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION + 1);
    db.run('UPDATE mail_schema_version SET version=?', [MAIL_SCHEMA_VERSION]);
    db.exec('DROP TABLE mail_actions');
    assert.deepEqual(checkMailConsistency(db).codes, ['schema-incomplete']);
    assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='mail_actions'"), undefined);
  });
});

test('logical identity/provider corruption is reported without reflecting private values or repairing rows', async () => fixture(async ({ db, repository }) => {
  seed(repository);
  const bad = JSON.stringify({ provider: 'graph', messageId: 'private-message-identity' });
  db.run('UPDATE mail_messages SET locator_json=?', [bad]);
  const result = checkMailConsistency(db);
  assert.ok(result.codes.includes('invalid-message-identity'));
  assert.ok(result.codes.includes('account-provider-mismatch'));
  assert.equal(result.ok, false); privateReport(result);
  assert.equal(db.get('SELECT locator_json FROM mail_messages').locator_json, bad);
}));

test('foreign-key violations and disabled enforcement are diagnosed without changing the setting', async () => fixture(async ({ db, repository }) => {
  seed(repository);
  db.exec('PRAGMA foreign_keys=OFF');
  db.run('INSERT INTO mail_memberships VALUES(?,?,?)', ['private-account', '["gmail","missing"]', 'missing-folder']);
  const result = checkMailConsistency(db);
  assert.ok(result.codes.includes('foreign-key-violation'));
  assert.ok(result.codes.includes('foreign-key-enforcement-disabled'));
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 0);
  assert.equal(db.get('SELECT count(*) AS count FROM mail_memberships').count, 2);
}));

test('missing publication and incomplete chunk objects cannot pass a shallow complete-content diagnostic', async () => fixture(async ({ db, repository, store }) => {
  seed(repository); await complete(store, repository);
  db.exec('DELETE FROM mail_blob_chunks WHERE length(data)>0');
  const missingChunks = checkMailConsistency(db);
  assert.ok(missingChunks.codes.includes('invalid-blob-chunks')); assert.equal(missingChunks.ok, false);
  db.exec('DELETE FROM mail_blob_publications');
  const missingPublication = checkMailConsistency(db);
  assert.ok(missingPublication.codes.includes('unpublished-content'));
  assert.ok(missingPublication.codes.includes('invalid-blob-publication'));
  assert.equal(missingPublication.ok, false); privateReport(missingPublication);
}));

test('shallow checks explicitly do not claim full content hash verification', async () => fixture(async ({ db, repository, store }) => {
  seed(repository); await complete(store, repository);
  db.run('UPDATE mail_blob_chunks SET data=?', [new Uint8Array(65536).fill(9)]);
  const result = checkMailConsistency(db);
  assert.equal(result.ok, true); assert.equal(result.contentHashesVerified, false);
  const raw = db.get("SELECT ref_id FROM mail_content_manifests WHERE kind='raw'").ref_id;
  assert.throws(() => [...store.read('private-account', raw)], /integrity/);
}));

test('keyset scan pages and total scan budget stay bounded; partial results never claim health', async () => fixture(async ({ db, repository }) => {
  seed(repository);
  for (let index = 0; index < 20; index++) seed(repository, `m-${index}`, false);
  let allCalls = 0;
  const watched = { ...db, all(sql, parameters) {
    assert.ok(sql.includes('LIMIT ?'));
    const rows = db.all(sql, parameters); assert.ok(rows.length <= 3); allCalls++; return rows;
  } };
  const limited = checkMailConsistency(watched, { batchSize: 3, maxRows: 5 });
  assert.equal(limited.scannedRows, 5); assert.equal(limited.scanComplete, false); assert.equal(limited.ok, false);
  assert.deepEqual(limited.codes, ['scan-budget-exhausted']);
  assert.equal(checkMailConsistency(watched, { batchSize: 3, maxRows: 1000 }).ok, true);
  assert.ok(allCalls > 5);
  assert.deepEqual(checkMailConsistency(watched, { deep: true }).codes, ['invalid-options']);
}));

test('SQLite diagnostic failures return fixed codes instead of database error details', async () => fixture(async ({ db }) => {
  const failed = { ...db, get() { throw new Error('secret matter id and filesystem path'); } };
  const result = checkMailConsistency(failed);
  assert.deepEqual(result.codes, ['database-check-failed']); assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('secret'));
}));


test('fast startup guard uses only schema metadata and settings, with fixed safe failures', async () => fixture(async ({ db, repository, store }) => {
  seed(repository); await complete(store, repository);
  const watched = { ...db, get(sql, parameters) {
    assert.ok(sql.includes('sqlite_schema') || sql.includes('pragma_table_info') || sql === 'SELECT version FROM mail_schema_version WHERE singleton=1' || sql === 'PRAGMA foreign_keys');
    assert.ok(!sql.includes('quick_check') && !sql.includes('foreign_key_check'));
    return db.get(sql, parameters);
  }, all() { throw new Error('Startup guard must not scan content'); } };
  assert.doesNotThrow(() => assertMailSchema(watched));
  const failed = { ...db, get() { throw new Error('Private account details'); } };
  assert.throws(() => assertMailSchema(failed), { message: 'Mail schema is not ready' });
  db.exec('PRAGMA foreign_keys=OFF');
  assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 0);
}));

test('fast startup guard refuses missing tables, missing columns and future versions before use', async () => {
  await fixture(async ({ db }) => {
    db.exec('DROP TABLE mail_actions');
    assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
    assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='mail_actions'"), undefined);
  });
  await fixture(async ({ db }) => {
    db.exec('ALTER TABLE mail_accounts DROP COLUMN display_name');
    assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
    assert.deepEqual(checkMailConsistency(db).codes, ['schema-incomplete']);
  });
  await fixture(async ({ db }) => {
    db.run('UPDATE mail_schema_version SET version=?', [MAIL_SCHEMA_VERSION + 1]);
    assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
    assert.equal(db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION + 1);
  });
});

test('Graph immutable identity keeps its stored content while a move replaces folder membership', async () => fixture(async ({ db, repository, store }) => {
  repository.createAccount({ id: 'graph-account', provider: 'graph', displayName: 'Synthetic Graph' });
  for (const folder of ['inbox', 'archive']) repository.putFolder('graph-account', { id: folder, name: folder, kind: 'folder' });
  const identity = { provider: 'graph', messageId: 'immutable-id' };
  const before = repository.ingestMessage('graph-account', { locator: identity, rfcMessageId: '<same@example.invalid>', subject: 'Original', memberships: ['inbox'] });
  const reference = await store.writePart('graph-account', identity, { kind: 'raw', maxBytes: 2 }, [new Uint8Array([42, 0])]);
  const after = repository.ingestMessage('graph-account', { locator: identity, rfcMessageId: '<same@example.invalid>', subject: 'Moved', memberships: ['archive'] });
  assert.equal(after, before);
  assert.equal(db.get('SELECT count(*) AS count FROM mail_messages').count, 1);
  const message = repository.readMessage('graph-account', identity);
  assert.deepEqual(message.memberships, ['archive']);
  assert.equal(message.content[0].ref_id, reference.id);
  assert.deepEqual(Buffer.concat([...store.read('graph-account', reference.id)]), Buffer.from([42, 0]));
  assert.equal(checkMailConsistency(db).ok, true);
}));


test('v3 fast guard requires journal tables/columns and refuses an unmigrated v2 schema', async () => fixture(async ({ db }) => {
  assert.doesNotThrow(() => assertMailSchema(db));
  db.exec('DROP TABLE mail_sync_scope_jobs');
  assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
  assert.deepEqual(checkMailConsistency(db).codes, ['schema-incomplete']);
 db.exec("DROP TABLE mail_graph_attachments; DROP TABLE mail_graph_messages; DROP TABLE mail_graph_folder_queue; DROP TABLE mail_graph_runs");
 for(const row of db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_search_*'"))db.exec('DROP TRIGGER "'+row.name+'"');
 db.exec('DROP TABLE mail_search_fts; DROP TABLE mail_search_documents; DROP TABLE mail_search_dirty; ALTER TABLE mail_messages DROP COLUMN is_read');
  db.exec('DROP TRIGGER mail_raw_projection_insert; DROP TRIGGER mail_raw_projection_update; DROP TABLE mail_mime_parts; DROP TABLE mail_mime_projections; DROP TABLE mail_gmail_metadata; DROP TABLE mail_gmail_presence; DROP TABLE mail_gmail_runs; DROP TABLE mail_action_jobs; DROP TABLE mail_account_credentials; DROP TABLE mail_sync_jobs; DROP TABLE mail_sync_scopes; UPDATE mail_schema_version SET version=2');
  assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
  assert.deepEqual(checkMailConsistency(db).codes, ['schema-upgrade-required']);
  migrateMailSchema(db);
  assert.doesNotThrow(() => assertMailSchema(db));
  db.exec('ALTER TABLE mail_sync_jobs DROP COLUMN last_error');
  assert.throws(() => assertMailSchema(db), { message: 'Mail schema is not ready' });
  assert.deepEqual(checkMailConsistency(db).codes, ['schema-incomplete']);
}));
