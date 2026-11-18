import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { restoreSpeechCache, sealSpeechCache, speechCacheKey, speechDependencyKey, frozenSpeechDependencyKey } from '../../apps/desktop/scripts/windows-arm64-speech-cache.mjs';

const inputs = { platform: 'win32', arch: 'arm64', node: 'v24.22.1', imageVersion: 'one', cmake: '4', packages: { addon: '8' }, files: { source: 'one' } };
const key = speechCacheKey(inputs);
const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
const noticeNames = ['onnxruntime-LICENSE', 'onnxruntime-ThirdPartyNotices.txt'];
const pinnedSpeech = JSON.parse(readFileSync(path.join(desktop, 'build/windows-arm64-speech.json'), 'utf8'));
const noticeHash = bytes => createHash('sha256').update(bytes).digest('hex');

test('vendored ONNX notices retain the original pinned bytes under Windows Git checkout settings', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'speech-notice-checkout-'));
  try {
    const directory = 'apps/desktop/build/windows-arm64-speech-notices';
    mkdirSync(path.join(root, directory), { recursive: true });
    cpSync(new URL('../../.gitattributes', import.meta.url), path.join(root, '.gitattributes'));
    for (const name of noticeNames) cpSync(path.join(desktop, 'build/windows-arm64-speech-notices', name), path.join(root, directory, name));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    const checkout = path.join(root, 'checkout'); mkdirSync(checkout);
    execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'checkout-index', '-a', '-f', `--prefix=${checkout}${path.sep}`], { cwd: root });
    for (const [index, expected] of [pinnedSpeech.onnxruntimeLicenseSha256, pinnedSpeech.onnxruntimeNoticesSha256].entries()) {
      assert.equal(noticeHash(readFileSync(path.join(checkout, directory, noticeNames[index]))), expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function coldSpeechBuild(fault = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'speech-notice-build-'));
  const app = path.join(root, 'desktop');
  const scripts = path.join(app, 'scripts'), build = path.join(app, 'build');
  const modules = path.join(app, 'node_modules');
  const sourceBytes = Buffer.from('synthetic source archive'), nativeBytes = Buffer.from('synthetic native archive');
  const pin = { ...pinnedSpeech, sourceSha256: noticeHash(sourceBytes), nativeSha256: noticeHash(nativeBytes) };
  const output = path.join(modules, 'sherpa-onnx-node');
  mkdirSync(scripts, { recursive: true }); mkdirSync(output, { recursive: true });
  mkdirSync(path.join(modules, 'cmake-js/bin'), { recursive: true });
  cpSync(path.join(desktop, 'build/windows-arm64-speech-notices'), path.join(build, 'windows-arm64-speech-notices'), { recursive: true });
  writeFileSync(path.join(build, 'windows-arm64-speech.json'), JSON.stringify(pin));
  writeFileSync(path.join(app, 'package.json'), '{}');
  writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'sherpa-onnx-node', version: pin.version }));
  writeFileSync(path.join(modules, 'cmake-js/bin/cmake-js'), '');
  for (const name of ['prepare-windows-arm64-speech.mjs', 'windows-arm64-speech-cache.mjs']) cpSync(path.join(desktop, 'scripts', name), path.join(scripts, name));
  if (fault === 'missing') rmSync(path.join(build, 'windows-arm64-speech-notices', noticeNames[1]));
  if (fault === 'tampered') writeFileSync(path.join(build, 'windows-arm64-speech-notices', noticeNames[1]), 'changed notice');
  const trace = path.join(root, 'requests'); writeFileSync(trace, '');
  const preload = path.join(root, 'preload.mjs');
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    globalThis.fetch = async url => {
      appendFileSync(${JSON.stringify(trace)}, url + '\\n');
      if (url === 'https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v${pin.version}.tar.gz') return new Response('synthetic source archive');
      if (url === 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v${pin.version}/sherpa-onnx-v${pin.version}-win-arm64-shared-MT-Release-lib.tar.bz2') return new Response('synthetic native archive');
      return new Response('upstream unavailable', { status: 404 });
    };
    const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
    cp.spawnSync = (command, args, options) => {
      if (path.basename(command) === 'tar.exe') {
        const temporary = options.cwd;
        if (args[1] === 'source.tar.gz') {
          const source = path.join(temporary, 'sherpa-onnx-${pin.version}');
          write(path.join(source, 'harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/fixture.cc'), 'synthetic addon source');
          write(path.join(source, 'scripts/node-addon-api/CMakeLists.txt'), 'synthetic cmake');
          write(path.join(source, 'sherpa-onnx/c-api/c-api.h'), 'synthetic header');
          write(path.join(source, 'LICENSE'), 'synthetic Sherpa license');
        } else {
          assert.equal(args[1], 'native.tar.bz2');
          write(path.join(temporary, 'sherpa-onnx-v${pin.version}-win-arm64-shared-MT-Release-lib/lib/onnxruntime.dll'), 'synthetic native library');
        }
      } else if (args[1] === 'compile') {
        write(path.join(args[args.indexOf('--directory') + 1], 'build/Release/sherpa-onnx.node'), 'synthetic native addon');
      } else {
        assert.equal(command, process.execPath);
        assert.equal(args[0], '-e');
      }
      return { status: 0 };
    };
    syncBuiltinESMExports();
  `);
  try {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scripts, 'prepare-windows-arm64-speech.mjs')], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, TARGET: 'aarch64-pc-windows-msvc', CARGO_CFG_TARGET_TRIPLE: 'aarch64-pc-windows-msvc', LEGALWORK_SPEECH_CACHE_DIRECTORY: '', SystemRoot: root },
    });
    return { ...result, requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
      notices: noticeNames.map(name => {
        try { return readFileSync(path.join(output, 'arm64-notices', name)); } catch { return undefined; }
      }) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a cold ARM64 speech build copies pinned local notices while the old upstream URLs return 404', () => {
  const result = coldSpeechBuild();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 2, 'Only the two pinned Sherpa archives need network access');
  assert.ok(result.requests.every(url => url.startsWith('https://github.com/k2-fsa/sherpa-onnx/')));
  for (const [index, expected] of [pinnedSpeech.onnxruntimeLicenseSha256, pinnedSpeech.onnxruntimeNoticesSha256].entries()) {
    assert.equal(noticeHash(result.notices[index]), expected);
  }
});

for (const fault of ['missing', 'tampered']) test(`a ${fault} local notice fails before downloads or compilation`, () => {
  const result = coldSpeechBuild(fault);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.requests, []);
  assert.match(result.stderr, /onnxruntime-ThirdPartyNotices\.txt/);
});

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
