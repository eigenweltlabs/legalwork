// Cache only the pinned native adapter/DLLs, never an installed node_modules tree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptName = 'speech-build-receipt.json';
const requiredFiles = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll',
  'sherpa-onnx-cxx-api.dll', 'onnxruntime_providers_shared.dll',
  'arm64-notices/sherpa-onnx-LICENSE', 'arm64-notices/onnxruntime-LICENSE', 'arm64-notices/onnxruntime-ThirdPartyNotices.txt'];
const allowed = name => /^(?:sherpa-onnx\.node|[\w.-]+\.dll|arm64-notices\/(?:sherpa-onnx-LICENSE|onnxruntime-LICENSE|onnxruntime-ThirdPartyNotices\.txt))$/.test(name);

export function speechCacheKey(inputs) {
  assert.equal(inputs.platform, 'win32');
  assert.equal(inputs.arch, 'arm64');
  return 'windows-arm64-speech-v1-' + digest(JSON.stringify(inputs));
}

export function speechDependencyKey(lockfile) {
  // Release stamping changes workspace importers, not registry package bytes.
  return digest(JSON.stringify({ packages: lockfile.packages, patches: lockfile.patchedDependencies }));
}

export function currentSpeechCacheKey() {
  const files = {};
  for (const name of ['build/windows-arm64-speech.json', 'scripts/prepare-windows-arm64-speech.mjs', 'scripts/windows-arm64-speech-cache.mjs']) {
    files[name] = digest(readFileSync(path.join(desktop, name)));
  }
  const packages = {};
  for (const name of ['sherpa-onnx-node', 'cmake-js', 'node-addon-api']) packages[name] = require(name + '/package.json').version;
  const lockfile = require('yaml').parse(readFileSync(path.join(desktop, '../../pnpm-lock.yaml'), 'utf8'));
  return speechCacheKey({ platform: process.platform, arch: process.arch, node: process.version,
    imageOS: process.env.ImageOS || 'local', imageVersion: process.env.ImageVersion || 'local',
    cmake: execFileSync('cmake', ['--version'], { encoding: 'utf8' }).split('\n')[0].trim(), packages, files,
    dependencyKey: speechDependencyKey(lockfile) });
}

function cacheFiles(directory, prefix = '') {
  return readdirSync(directory).flatMap(name => {
    const relative = prefix + name;
    const metadata = lstatSync(path.join(directory, name));
    assert.ok(!metadata.isSymbolicLink(), 'Speech cache cannot contain links');
    if (metadata.isDirectory()) {
      assert.equal(relative, 'arm64-notices');
      return cacheFiles(path.join(directory, name), relative + '/');
    }
    assert.ok(metadata.isFile(), 'Speech cache must contain regular files');
    if (relative === receiptName) return [];
    assert.ok(allowed(relative), 'Unexpected speech cache file: ' + relative);
    return [relative];
  }).sort();
}

export function restoreSpeechCache(directory, destination, key) {
  if (!existsSync(directory)) return false;
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Speech cache must be a real directory');
  if (readdirSync(directory).length === 0) return false;
  const files = cacheFiles(directory);
  const receipt = JSON.parse(readFileSync(path.join(directory, receiptName), 'utf8'));
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.key, key, 'Speech cache build inputs changed');
  assert.deepEqual(files, Object.keys(receipt.files).sort(), 'Speech cache file set changed');
  for (const name of requiredFiles) assert.ok(files.includes(name), 'Incomplete speech cache: ' + name);
  for (const name of files) assert.equal(digest(readFileSync(path.join(directory, name))), receipt.files[name], 'Corrupt speech cache: ' + name);
  // Verify the whole cache before modifying the freshly installed package.
  for (const name of files) {
    mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
    copyFileSync(path.join(directory, name), path.join(destination, name));
  }
  return true;
}

export function sealSpeechCache(directory, source, key) {
  assert.ok(!existsSync(directory) || readdirSync(directory).length === 0, 'Do not overwrite an existing speech cache');
  const names = [...requiredFiles, ...readdirSync(source).filter(name => name.endsWith('.dll'))];
  const files = {};
  for (const name of [...new Set(names)].sort()) {
    assert.ok(allowed(name));
    assert.ok(lstatSync(path.join(source, name)).isFile(), 'Native speech output must be a regular file');
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    copyFileSync(path.join(source, name), path.join(directory, name));
    files[name] = digest(readFileSync(path.join(directory, name)));
  }
  writeFileSync(path.join(directory, receiptName), JSON.stringify({ schema: 1, key, files }) + '\n', { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], 'key');
  const key = currentSpeechCacheKey();
  const directory = path.join(process.env.RUNNER_TEMP, 'windows-arm64-speech');
  appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\ndirectory=${directory}\n`);
  appendFileSync(process.env.GITHUB_ENV, `LEGALWORK_SPEECH_CACHE_DIRECTORY=${directory}\nLEGALWORK_SPEECH_CACHE_KEY=${key}\n`);
  console.log('Native speech cache key: ' + key);
}
