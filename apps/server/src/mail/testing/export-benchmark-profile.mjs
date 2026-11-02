/** Export only a frozen, generator-verified synthetic database. */
import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { readFile, mkdir, copyFile, writeFile, chmod, lstat, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { enforceMailWindowsAcl } from '../storage/windows-acl.js';
import { MailContentStore } from '../storage/content-store.js';
import { benchmarkMessage, CORPUS_VERSION } from './large-mailbox-corpus.mjs';

const fullCorpusSha256 = '698fa2c64e3b253dd75455e748f83fc02b29fd6214988a7c6818c119f4d85425';
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function exportBenchmarkProfile({ source: suppliedSource, destination: suppliedDestination, checkpoint = false }) {
  assert.equal(typeof checkpoint, 'boolean');
  const source = resolve(suppliedSource), destination = resolve(suppliedDestination);
  const path = relative(source, destination);
  assert(path !== '' && (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)), 'Export must be outside the source profile');
  const bytes = await readFile(join(source, 'benchmark-profile.json'));
  assert(bytes.length <= 65536, 'Invalid synthetic metadata');
  const metadata = JSON.parse(bytes.toString('utf8'));
  assert.equal(metadata.kind, 'legalwork-synthetic-benchmark');
  const count = metadata.count;
  assert(Number.isSafeInteger(count) && count >= 100 && count <= 100000);
  if (!checkpoint) assert.equal(count, 100000, 'Completed corpus export requires 100000 messages');
  const ownerId = metadata.ownerId ?? 'benchmark';
  assert(['benchmark', 'desktop-local'].includes(ownerId));
  const database = metadata.database ?? 'mail.sqlite';
  assert(['mail.sqlite', 'mail/mail.sqlite'].includes(database), 'Invalid synthetic database path');
  const databasePath = join(source, database), existing = await lstat(databasePath);
  assert(existing.isFile() && existing.size > 0, 'Synthetic database is missing');
  let report = null;
  if (!checkpoint) {
    assert.equal(typeof metadata.report, 'string');
    report = JSON.parse(await readFile(resolve(source, metadata.report), 'utf8'));
    assert.equal(report.corpus.version, CORPUS_VERSION);
    assert.equal(report.corpus.count, count);
    assert.equal(report.corpus.sha256, fullCorpusSha256);
    assert.equal(report.corpus.coverage.indexed, count);
    assert.equal(report.corpus.coverage.dirty, 0);
  }
  const sourceSha256 = metadata.sourceSha256 ?? report?.sourceSha256 ?? null;
  assert(sourceSha256 === null || typeof sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(sourceSha256), 'Invalid source fingerprint');
  const key = Buffer.from(metadata.key, 'base64');
  let db, created = false, published = false;
  try {
    assert.equal(key.length, 32);
    db = await openEncryptedMailDatabase({ path: databasePath, key });
    // Same offline fence as production maintenance. Live WAL connections reject this copy.
    assert.equal(db.get('PRAGMA locking_mode=EXCLUSIVE')?.locking_mode, 'exclusive');
    assert.equal(db.get('PRAGMA journal_mode=DELETE')?.journal_mode, 'delete');
    db.exec('BEGIN EXCLUSIVE');
    assert.deepEqual(db.all('SELECT id,owner_id FROM mail_accounts ORDER BY id'),
      ['benchmark-a', 'benchmark-b', 'benchmark-c'].map(id => ({ id, owner_id: ownerId })));
    const coverage = {
      messages: db.get('SELECT count(*) n FROM mail_messages').n,
      raw: db.get("SELECT count(*) n FROM mail_content_manifests WHERE kind='raw' AND state='stored'").n,
      body: db.get("SELECT count(*) n FROM mail_content_manifests WHERE kind='body' AND state='stored'").n,
      indexed: db.get('SELECT count(*) n FROM mail_search_documents').n,
      dirty: db.get('SELECT count(*) n FROM mail_search_dirty').n,
      extractionPending: db.get("SELECT count(*) n FROM mail_attachment_extractions WHERE state IN ('queued','running')").n,
    };
    assert.equal(coverage.messages, count, 'Incomplete original inventory');
    assert.equal(coverage.raw, count, 'Incomplete original inventory');
    if (!checkpoint) { assert.equal(coverage.indexed, count); assert.equal(coverage.dirty, 0); }
    for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%credentials%' OR name LIKE '%oauth%')")) {
      assert.match(name, /^[a-z_]+$/);
      assert.equal(db.get('SELECT count(*) n FROM ' + name).n, 0, 'Synthetic credentials must be empty');
    }
    const content = new MailContentStore(db, ownerId), hash = createHash('sha256');
    for (let index = 0; index < count; index++) {
      const expected = benchmarkMessage(index), messageKey = JSON.stringify(['gmail', expected.locator.messageId]);
      const part = db.get("SELECT ref_id FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='raw' AND state='stored'", [expected.accountId, messageKey]);
      assert(part, 'Missing synthetic original ' + index);
      const actual = createHash('sha256');
      for (const chunk of content.read(expected.accountId, part.ref_id)) actual.update(chunk);
      assert.equal(actual.digest('hex'), expected.hash, 'Synthetic original ' + index);
      hash.update(expected.hash);
    }
    const corpusSha256 = hash.digest('hex');
    if (count === 100000) assert.equal(corpusSha256, fullCorpusSha256);
    assert.equal(db.get('PRAGMA integrity_check')?.integrity_check, 'ok');
    await mkdir(destination, { recursive: false, mode: 0o700 }); created = true;
    await enforceMailWindowsAcl(destination, true);
    const target = join(destination, 'mail.sqlite');
    await copyFile(databasePath, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600); await enforceMailWindowsAcl(target, false);
    const databaseSha256 = await fileHash(target);
    assert.equal(databaseSha256, await fileHash(databasePath), 'Synthetic snapshot changed');
    db.exec('ROLLBACK'); db.close(); db = undefined;
    const exported = {
      kind: checkpoint ? 'legalwork-synthetic-benchmark-checkpoint' : metadata.kind,
      count, ownerId, key: metadata.key, database: 'mail.sqlite',
      report: checkpoint ? null : 'baseline.json', corpusVersion: CORPUS_VERSION, corpusSha256,
      sourceSha256,
      syntheticOnly: true, originalsVerified: count, disposableTestKey: true,
      measurementState: checkpoint ? 'incomplete' : 'complete', coverage, databaseSha256,
    };
    if (report) await writeFile(join(destination, 'baseline.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(destination, 'benchmark-profile.json'), JSON.stringify(exported) + '\n', { flag: 'wx', mode: 0o600 });
    published = true;
    return exported;
  } finally {
    try { db?.close(); }
    finally {
      key.fill(0);
      if (created && !published) await rm(destination, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), checkpoint = args[0] === '--checkpoint';
  if (checkpoint) args.shift();
  assert.equal(args.length, 2, 'Usage: export-benchmark-profile.mjs [--checkpoint] <synthetic-profile> <new-directory>');
  const result = await exportBenchmarkProfile({ source: args[0], destination: args[1], checkpoint });
  console.log(JSON.stringify({ kind: result.kind, originalsVerified: result.originalsVerified, measurementState: result.measurementState }));
}
