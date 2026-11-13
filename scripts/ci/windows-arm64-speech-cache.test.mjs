import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { restoreSpeechCache, sealSpeechCache, speechCacheKey, speechDependencyKey, frozenSpeechDependencyKey } from '../../apps/desktop/scripts/windows-arm64-speech-cache.mjs';

const inputs = { platform: 'win32', arch: 'arm64', node: 'v24.22.1', imageVersion: 'one', cmake: '4', packages: { addon: '8' }, files: { source: 'one' } };
const key = speechCacheKey(inputs);
test('real release stamping and offline pnpm resync retain the installed native build identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'speech-version-stamp-'));
  const { parse, stringify } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.4.0' }));
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: [apps/*]\nlinkWorkspacePackages: true\npreferWorkspacePackages: true\nminimumReleaseAge: 0\n');
    for (const name of ['app', 'desktop', 'orchestrator', 'server']) {
      mkdirSync(path.join(root, 'apps', name), { recursive: true });
      writeFileSync(path.join(root, 'apps', name, 'package.json'), JSON.stringify({ name: name === 'server' ? 'legalwork-server' : name,
        version: '0.0.0', ...(name === 'orchestrator' ? { dependencies: { 'legalwork-server': '0.0.0' } } : {}) }));
    }
    const resync = () => {
      try { execFileSync('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--offline', '--ignore-scripts'], { cwd: root, stdio: 'pipe' }); }
      catch (error) { throw new Error(String(error.stdout) + String(error.stderr)); }
    };
    resync();
    const filename = path.join(root, 'pnpm-lock.yaml');
    const before = parse(readFileSync(filename, 'utf8'));
    // A stale unrelated registry entry is pruned by the real pnpm resync.
    before.packages = { 'unrelated-package@1.0.0': { resolution: { integrity: 'sha512-YQ==' } } };
    before.snapshots = { 'unrelated-package@1.0.0': {} };
    writeFileSync(filename, stringify(before));
    const installed = speechDependencyKey(before);
    const script = path.join(root, 'scripts/release/apply-version.mjs');mkdirSync(path.dirname(script), { recursive: true });
    cpSync(new URL('../release/apply-version.mjs', import.meta.url), script);
    execFileSync(process.execPath, [script, '--version', '1.2.3-alpha.0.g1234567'], { stdio: 'pipe' });
    resync();
    const after = parse(readFileSync(filename, 'utf8'));
    assert.equal(JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version, '1.2.3-alpha.0.g1234567');
    assert.notEqual(speechDependencyKey(after), installed, 'Real resync must exercise registry metadata drift');
    assert.equal(frozenSpeechDependencyKey(after, installed), installed);
    assert.equal(speechCacheKey({ ...inputs, dependencyKey: frozenSpeechDependencyKey(after, installed) }),
      speechCacheKey({ ...inputs, dependencyKey: installed }));
    assert.throws(() => frozenSpeechDependencyKey(after, 'invalid'), /match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
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
