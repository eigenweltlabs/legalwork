import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { readFile, lstat, copyFile, chmod, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { enforceMailWindowsAcl } from '../storage/windows-acl.js';
import { fileHash } from './export-benchmark-profile.mjs';
import { CORPUS_VERSION } from './large-mailbox-corpus.mjs';
import { assertBenchmarkOutputOutside } from './benchmark-process.mjs';

/** Copy a frozen checkpoint without opening its database or changing its bytes. */
export async function copyBenchmarkCheckpoint({ source: suppliedSource, destination: suppliedDestination }) {
  const source = resolve(suppliedSource), destination = resolve(suppliedDestination);
  await assertBenchmarkOutputOutside(source, destination);
  const metadataPath = join(source, 'benchmark-profile.json');
  const state = await lstat(metadataPath);
  assert(state.isFile() && state.size <= 65536, 'Invalid checkpoint metadata');
  const bytes = await readFile(metadataPath), metadata = JSON.parse(bytes.toString('utf8'));
  assert.equal(metadata.kind, 'legalwork-synthetic-benchmark-checkpoint');
  assert.equal(metadata.measurementState, 'incomplete'); assert.equal(metadata.report, null);
  assert.equal(metadata.syntheticOnly, true); assert.equal(metadata.disposableTestKey, true);
  assert.equal(metadata.database, 'mail.sqlite'); assert.equal(metadata.corpusVersion, CORPUS_VERSION);
  assert(Number.isSafeInteger(metadata.count) && metadata.count >= 100 && metadata.count <= 100000);
  assert.equal(metadata.originalsVerified, metadata.count);
  assert(['benchmark', 'desktop-local'].includes(metadata.ownerId));
  assert.match(metadata.databaseSha256, /^[0-9a-f]{64}$/); assert.match(metadata.corpusSha256, /^[0-9a-f]{64}$/);
  assert(metadata.sourceSha256 === null || typeof metadata.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(metadata.sourceSha256));
  const originalInputSourceSha256 = Object.hasOwn(metadata, 'originalInputSourceSha256') ? metadata.originalInputSourceSha256 : metadata.sourceSha256;
  assert(originalInputSourceSha256 === null || typeof originalInputSourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(originalInputSourceSha256));
  assert.equal(typeof metadata.key, 'string'); assert.match(metadata.key, /^[A-Za-z0-9+/]{43}=$/);
  const database = join(source, 'mail.sqlite'), original = await lstat(database);
  assert(original.isFile() && original.size > 0, 'Checkpoint database is missing');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(database + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Error('Checkpoint must be frozen without journal sidecars');
  }
  assert.equal(await fileHash(database), metadata.databaseSha256, 'Checkpoint file hash mismatch');
  let copied = false;
  try {
    await copyFile(database, destination, constants.COPYFILE_EXCL); copied = true;
    await chmod(destination, 0o600); await enforceMailWindowsAcl(destination, false);
    assert.equal(await fileHash(destination), metadata.databaseSha256, 'Checkpoint copy hash mismatch');
    const after = await lstat(database);
    assert.equal(after.size, original.size); assert.equal(after.mtimeMs, original.mtimeMs);
    assert.equal(await fileHash(database), metadata.databaseSha256, 'Checkpoint changed during copy');
    assert.deepEqual(await readFile(metadataPath), bytes, 'Checkpoint metadata changed during copy');
    return { count: metadata.count, ownerId: metadata.ownerId, key: metadata.key,
      origin: { metadataSha256: createHash('sha256').update(bytes).digest('hex'), databaseSha256: metadata.databaseSha256,
        corpusSha256: metadata.corpusSha256, sourceSha256: metadata.sourceSha256, originalInputSourceSha256 } };
  } catch (error) {
    if (copied) await rm(destination, { force: true });
    throw error;
  }
}
