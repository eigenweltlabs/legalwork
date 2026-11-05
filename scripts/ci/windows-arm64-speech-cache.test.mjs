import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { restoreSpeechCache, sealSpeechCache, speechCacheKey, speechDependencyKey } from '../../apps/desktop/scripts/windows-arm64-speech-cache.mjs';

const inputs = { platform: 'win32', arch: 'arm64', node: 'v24.22.1', imageVersion: 'one', cmake: '4', packages: { addon: '8' }, files: { source: 'one' } };
const key = speechCacheKey(inputs);
test('speech dependency identity ignores stamped workspace versions and changes with registry bytes or patches', () => {
  const lock = { importers: { desktop: { version: 'one' } }, packages: { cmake: { integrity: 'one' } }, patchedDependencies: {} };
  assert.equal(speechDependencyKey(lock), speechDependencyKey({ ...lock, importers: { desktop: { version: 'two' } } }));
  assert.notEqual(speechDependencyKey(lock), speechDependencyKey({ ...lock, packages: { cmake: { integrity: 'two' } } }));
  assert.notEqual(speechDependencyKey(lock), speechDependencyKey({ ...lock, patchedDependencies: { cmake: 'changed' } }));
});
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-speech-cache-'));
  const source = path.join(root, 'source'), cache = path.join(root, 'cache'), restored = path.join(root, 'restored');
  mkdirSync(path.join(source, 'arm64-notices'), { recursive: true });
  for (const name of ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime_providers_shared.dll', 'arm64-notices/sherpa-onnx-LICENSE',
    'arm64-notices/onnxruntime-LICENSE', 'arm64-notices/onnxruntime-ThirdPartyNotices.txt']) writeFileSync(path.join(source, name), name);
  try { run({ source, cache, restored }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('native speech cache separates source, compiler, Node, architecture and host image', () => {
  assert.equal(key, speechCacheKey(structuredClone(inputs)));
  for (const replacement of [{ node: 'v24.23.0' }, { imageVersion: 'two' }, { cmake: '5' }, { packages: { addon: '9' } }, { files: { source: 'two' } }]) {
    assert.notEqual(key, speechCacheKey({ ...inputs, ...replacement }));
  }
  assert.throws(() => speechCacheKey({ ...inputs, arch: 'x64' }));
  assert.throws(() => speechCacheKey({ ...inputs, platform: 'darwin' }));
});

test('verified native speech output restores the adapter, sibling DLLs and notices', () => fixture(({ source, cache, restored }) => {
  assert.equal(restoreSpeechCache(cache, restored, key), false);
  sealSpeechCache(cache, source, key);
  assert.equal(restoreSpeechCache(cache, restored, key), true);
  assert.equal(readFileSync(path.join(restored, 'sherpa-onnx.node'), 'utf8'), 'sherpa-onnx.node');
  assert.equal(readFileSync(path.join(restored, 'arm64-notices/onnxruntime-LICENSE'), 'utf8'), 'arm64-notices/onnxruntime-LICENSE');
  assert.throws(() => sealSpeechCache(cache, source, key), /overwrite/);
}));

test('changed, incomplete, extra and corrupt native speech bytes fail before package writes', () => {
  for (const mutate of [
    cache => writeFileSync(path.join(cache, 'sherpa-onnx.node'), 'tampered'),
    cache => rmSync(path.join(cache, 'onnxruntime.dll')),
    cache => writeFileSync(path.join(cache, 'unexpected.js'), 'untrusted'),
    cache => rmSync(path.join(cache, 'speech-build-receipt.json')),
    cache => { rmSync(path.join(cache, 'sherpa-onnx.node')); symlinkSync(path.join(cache, 'onnxruntime.dll'), path.join(cache, 'sherpa-onnx.node')); },
  ]) fixture(({ source, cache, restored }) => {
    sealSpeechCache(cache, source, key);mutate(cache);
    assert.throws(() => restoreSpeechCache(cache, restored, key));
    assert.throws(() => readFileSync(path.join(restored, 'sherpa-onnx.node')));
  });
  fixture(({ source, cache, restored }) => {
    sealSpeechCache(cache, source, key);
    assert.throws(() => restoreSpeechCache(cache, restored, 'different'), /inputs changed/);
  });
});
