/** Actual encrypted Node test. Run the Bun launcher to compile TS into an isolated temp directory. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { MailRepository } from './repository.js';
import { MailContentStore, MAIL_CONTENT_CHUNK_BYTES as CHUNK } from './content-store.js';

const locator = messageId => ({ provider: 'gmail', messageId });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), 'legalwork-mail-content-'));
  const path = join(directory, 'mail.sqlite');
  const key = randomBytes(32);
  let database = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(database);
    await body({ path, key, db: database, repository: new MailRepository(database, 'owner-a'), store: new MailContentStore(database, 'owner-a'),
      async reopen() { database.close(); database = await openEncryptedMailDatabase({ path, key }); return database; } });
  } finally { database.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}
function seed(repository, accountId = 'a', messageId = 'one') {
  if (!repository.listAccounts().some(account => account.id === accountId)) {
    repository.createAccount({ id: accountId, provider: 'gmail', displayName: 'Synthetic' });
    repository.putFolder(accountId, { id: 'inbox', name: 'Inbox', kind: 'label' });
    repository.putFolder(accountId, { id: 'contract', name: 'Contract', kind: 'label' });
  }
  repository.ingestMessage(accountId, { locator: locator(messageId), rfcMessageId: '<same@example.invalid>', subject: 'Synthetic', memberships: ['inbox', 'contract'] });
}
function* generated(count) {
  for (let index = 0; index < count; index++) yield new Uint8Array(CHUNK).fill(index % 251);
}
function generatedHash(count) {
  const hash = createHash('sha256');
  for (const chunk of generated(count)) hash.update(chunk);
  return hash.digest('hex');
}
function readHash(store, accountId, refId) {
  const hash = createHash('sha256'); let bytes = 0; let chunks = 0;
  for (const chunk of store.read(accountId, refId)) {
    assert.ok(chunk.byteLength <= CHUNK);
    bytes += chunk.byteLength; chunks++; hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes, chunks };
}

test('encrypted content writes/readback/reopen are bounded, coalesced, verified and invisible until publication', async () => fixture(async ({ repository, store, db, reopen }) => {
  seed(repository);
  const count = 64; // 4 MiB; generated and verified without accumulating the content.
  const expectedSha256 = generatedHash(count);
  async function* source() {
    for (let index = 0; index < count; index++) {
      assert.equal(db.get("SELECT count(*) AS count FROM mail_blob_publications").count, 0);
      assert.equal(repository.readMessage('a', locator('one')).content.length, 0);
      assert.equal(store.listStaging('a')[0].bytes, index * CHUNK); // Prior chunk persisted before producer advances.
      yield new Uint8Array(CHUNK).fill(index % 251);
    }
  }
  const ref = await store.writePart('a', locator('one'), { kind: 'raw', maxBytes: count * CHUNK, expectedBytes: count * CHUNK, expectedSha256 }, source());
  assert.deepEqual(readHash(store, 'a', ref.id), { sha256: expectedSha256, bytes: count * CHUNK, chunks: count });
  assert.equal(repository.readMessage('a', locator('one')).contentState, 'downloading');
  const reopened = await reopen();
  const reader = new MailContentStore(reopened, 'owner-a');
  assert.deepEqual(readHash(reader, 'a', ref.id), { sha256: expectedSha256, bytes: count * CHUNK, chunks: count });
  assert.equal(reader.listStaging('a').length, 0);
  const chunks = [new Uint8Array(7).fill(1), new Uint8Array(CHUNK).fill(2), new Uint8Array(9).fill(3)];
  const small = await reader.writePart('a', locator('one'), { kind: 'attachment', partId: 'p1', maxBytes: CHUNK + 16 }, chunks);
  assert.equal(readHash(reader, 'a', small.id).chunks, 2);
}));

test('empty bodies and same-account SHA refs work across messages/labels without cross-account aliasing', async () => fixture(async ({ repository, store, db }) => {
  seed(repository); seed(repository, 'a', 'two'); seed(repository, 'b');
  const ref = await store.writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  const shared = await store.writePart('a', locator('two'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  const other = await store.writePart('b', locator('one'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  assert.equal(shared.id, ref.id); assert.equal(other.id, ref.id);
  assert.equal(db.get('SELECT count(*) AS count FROM mail_blob_objects').count, 2);
  assert.equal(db.get('SELECT count(*) AS count FROM mail_content_refs').count, 2);
  assert.equal(repository.readMessage('a', locator('one')).memberships.length, 2);
  const empty = await store.writePart('a', locator('one'), { kind: 'body', maxBytes: 0, expectedBytes: 0 }, []);
  assert.equal(empty.sha256, digest(new Uint8Array()));
  assert.equal(readHash(store, 'a', empty.id).chunks, 0);
  repository.setAttachmentsEnumerated('a', locator('one'), true);
  assert.equal(repository.readMessage('a', locator('one')).contentState, 'complete');
  const foreign = new MailContentStore(db, 'owner-b');
  assert.throws(() => [...foreign.read('a', ref.id)], /account not found/);
  await assert.rejects(foreign.writePart('a', locator('one'), { kind: 'raw', maxBytes: 0 }, []), /account not found/);
  assert.throws(() => foreign.listStaging('a'), /account not found/);
  assert.throws(() => foreign.discardStaging('a', 'anything'), /account not found/);
  assert.throws(() => [...store.read('b', empty.id)], /unavailable/);
}));

test('source failures, incorrect expectations and byte limits preserve an existing durable part', async () => fixture(async ({ repository, store }) => {
  seed(repository);
  const ref = await store.writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  async function* interrupted() { yield new Uint8Array(CHUNK).fill(8); throw new Error('source interrupted'); }
  const attempts = [
    [{ kind: 'raw', maxBytes: CHUNK * 2 }, interrupted(), /source interrupted/],
    [{ kind: 'raw', maxBytes: CHUNK - 1 }, generated(1), /byte limit/],
    [{ kind: 'raw', maxBytes: CHUNK, expectedBytes: CHUNK - 1 }, generated(1), /byte limit/],
    [{ kind: 'raw', maxBytes: CHUNK, expectedBytes: CHUNK }, [], /size does not match/],
    [{ kind: 'raw', maxBytes: CHUNK, expectedSha256: 'f'.repeat(64) }, generated(1), /hash does not match/],
    [{ kind: 'raw', maxBytes: CHUNK * 2 }, [new Uint8Array(CHUNK + 1)], /64 KiB/],
    [{ kind: 'raw', maxBytes: 2 }, ['bad'], /Uint8Arrays/],
    [{ kind: 'raw', maxBytes: -1 }, [], /greater than|Too small/],
    [{ kind: 'raw', maxBytes: 0, expectedBytes: 1 }, [], /exceeds byte limit/],
  ];
  for (const [options, source, error] of attempts) {
    await assert.rejects(store.writePart('a', locator('one'), options, source), error);
    assert.equal(repository.readMessage('a', locator('one')).content[0].ref_id, ref.id);
    assert.equal(store.listStaging('a').length, 0);
    assert.equal(readHash(store, 'a', ref.id).sha256, ref.sha256);
  }
}));

test('chunk disk failure and final publication failure roll back without changing old content or cursor', async () => fixture(async ({ repository, store, db }) => {
  seed(repository);
  const ref = await store.writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  db.run('INSERT INTO mail_cursors VALUES(?,?,?)', ['a', 'inbox', 'unchanged']);
  for (const failureSql of ['INSERT INTO mail_blob_chunks', 'INSERT INTO mail_blob_publications']) {
    let failed = false;
    const failing = { ...db, run(sql, parameters) {
      const result = db.run(sql, parameters);
      if (!failed && sql.includes(failureSql)) { failed = true; throw new Error('injected disk failure'); }
      return result;
    } };
    await assert.rejects(new MailContentStore(failing, 'owner-a').writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK * 2 }, generated(2)), /disk failure/);
    assert.equal(failed, true);
    assert.equal(repository.readMessage('a', locator('one')).content[0].ref_id, ref.id);
    assert.equal(db.get('SELECT cursor FROM mail_cursors').cursor, 'unchanged');
    assert.equal(db.get('SELECT count(*) AS count FROM mail_content_refs').count, 1);
    assert.equal(store.listStaging('a').length, 0);
  }
}));

test('staging cleanup cannot remove published/shared/draft content, and reads detect invalid persisted bytes', async () => fixture(async ({ repository, store, db }) => {
  seed(repository); seed(repository, 'a', 'two');
  const ref = await store.writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  await store.writePart('a', locator('two'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  db.run('INSERT INTO mail_drafts VALUES(?,?,?,?)', ['a', 'draft', 0, ref.id]);
  const object = db.get('SELECT object_id FROM mail_blob_publications WHERE ref_id=?', [ref.id]).object_id;
  assert.equal(store.discardStaging('a', object), false);
  db.run("UPDATE mail_blob_objects SET state='staging' WHERE id=?", [object]);
  assert.equal(store.discardStaging('a', object), false); // Publication is a second independent guard.
  db.run("UPDATE mail_blob_objects SET state='published' WHERE id=?", [object]);
  assert.equal(readHash(store, 'a', ref.id).bytes, CHUNK);
  db.run('UPDATE mail_blob_chunks SET data=? WHERE object_id=?', [new Uint8Array(CHUNK).fill(9), object]);
  assert.throws(() => readHash(store, 'a', ref.id), /integrity/);
  await assert.rejects(store.writePart('a', locator('two'), { kind: 'raw', maxBytes: CHUNK }, generated(1)), /integrity/);
}));

function restoreV1Shape(db) {
  db.exec('DROP TABLE mail_blob_publications; DROP TABLE mail_blob_chunks; DROP TABLE mail_blob_objects');
  db.run('UPDATE mail_schema_version SET version=1');
}
test('v1 to v2 preserves legacy metadata, is idempotent and rolls back an injected migration failure', async () => fixture(async ({ repository, db }) => {
  seed(repository);
  repository.putContent('a', locator('one'), { kind: 'raw', state: 'stored', reference: { id: 'legacy', bytes: 3, sha256: 'a'.repeat(64) } });
  restoreV1Shape(db);
  const before = repository.readMessage('a', locator('one'));
  const faulty = { ...db, exec(sql) { db.exec(sql); if (sql.includes('CREATE TABLE mail_blob_objects')) throw new Error('migration interruption'); } };
  assert.throws(() => migrateMailSchema(faulty), /migration interruption/);
  assert.equal(db.get('SELECT version FROM mail_schema_version').version, 1);
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='mail_blob_objects'"), undefined);
  assert.deepEqual(repository.readMessage('a', locator('one')), before);
  migrateMailSchema(db); migrateMailSchema(db);
  assert.equal(db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
  assert.deepEqual(repository.readMessage('a', locator('one')), before);
  assert.throws(() => [...new MailContentStore(db, 'owner-a').read('a', 'legacy')], /unavailable/);
}));

test('process death after a durable staging chunk preserves prior manifest; reopen permits explicit cleanup and retry', async () => fixture(async ({ repository, store, path, key, reopen }) => {
  seed(repository);
  const ref = await store.writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK }, generated(1));
  const databaseModule = new URL('./database.js', import.meta.url).href;
  const contentModule = new URL('./content-store.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {readFileSync} from 'node:fs';
    import {openEncryptedMailDatabase} from ${JSON.stringify(databaseModule)};
    import {MailContentStore} from ${JSON.stringify(contentModule)};
    const input=JSON.parse(readFileSync(0,'utf8'));
    const db=await openEncryptedMailDatabase({path:input.path,key:Buffer.from(input.key,'base64')});
    async function* source(){yield new Uint8Array(65536).fill(99);process.kill(process.pid,'SIGKILL');}
    await new MailContentStore(db,'owner-a').writePart('a',{provider:'gmail',messageId:'one'},{kind:'raw',maxBytes:131072},source());
  `], { input: JSON.stringify({ path, key: key.toString('base64') }), encoding: 'utf8', timeout: 20000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, 'SIGKILL');
  const reopened = await reopen();
  const after = new MailContentStore(reopened, 'owner-a');
  assert.equal(new MailRepository(reopened, 'owner-a').readMessage('a', locator('one')).content[0].ref_id, ref.id);
  const stages = after.listStaging('a'); assert.equal(stages.length, 1); assert.equal(stages[0].bytes, CHUNK);
  assert.equal(after.discardStaging('a', stages[0].id), true);
  assert.equal(after.discardStaging('a', stages[0].id), false);
  const retried = await after.writePart('a', locator('one'), { kind: 'raw', maxBytes: CHUNK * 2 }, generated(2));
  assert.equal(readHash(after, 'a', retried.id).bytes, CHUNK * 2);
  assert.equal(readHash(after, 'a', ref.id).bytes, CHUNK); // No published GC, even after replacement.
}));
