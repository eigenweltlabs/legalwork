import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandboxCacheKey, verifyRuntimeCache, writeRuntimeReceipt } from './cache-sandbox-runtime.mjs';

test('runtime cache rejects changed inputs, missing files, tampering and links', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-cache-'));
  try {
    for (const name of ['kernel', 'initrd.gz']) writeFileSync(path.join(root, name), 'guest fixture');
    writeRuntimeReceipt(root, 'exact-inputs');
    assert.doesNotThrow(() => verifyRuntimeCache(root, 'exact-inputs', 'guest', 'arm64'));
    assert.throws(() => verifyRuntimeCache(root, 'changed-inputs', 'guest', 'arm64'), /identity changed/);
    writeFileSync(path.join(root, 'kernel'), 'corrupt');
    assert.throws(() => verifyRuntimeCache(root, 'exact-inputs', 'guest', 'arm64'), /corruption/);
    rmSync(path.join(root, 'kernel'));
    assert.throws(() => verifyRuntimeCache(root, 'exact-inputs', 'guest', 'arm64'), /missing/);
    symlinkSync(path.join(root, 'initrd.gz'), path.join(root, 'kernel'));
    assert.throws(() => writeRuntimeReceipt(root, 'exact-inputs'), /ordinary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('guest and native architecture cache identities cannot collide', () => {
  assert.notEqual(sandboxCacheKey('guest', 'arm64'), sandboxCacheKey('runtime', 'arm64'));
  assert.notEqual(sandboxCacheKey('runtime', 'x64'), sandboxCacheKey('runtime', 'arm64'));
  assert.throws(() => sandboxCacheKey('runtime', 'unknown'));
});
