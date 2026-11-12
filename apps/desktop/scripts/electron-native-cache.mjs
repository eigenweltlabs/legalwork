// Reuse only better-sqlite3's Electron binary and rebuild marker. The normal
// dependency walker still prepares any other/new native modules afterward.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['.forge-meta', 'better_sqlite3.node'];

export function electronNativeCacheKey(identity) {
  assert.equal(identity.platform, 'win32');
  assert.ok(['arm64', 'x64'].includes(identity.arch));
  assert.match(identity.electron, /^\d+\.\d+\.\d+$/);
  assert.match(identity.abi, /^\d+$/);
  return 'electron-sqlite-v1-' + digest(JSON.stringify(identity));
}

function sourceFiles(directory, prefix = '') {
  const result = {};
  for (const name of readdirSync(directory).sort()) {
    if (!prefix && ['build', 'bin', 'node_modules'].includes(name)) continue;
    const filename = path.join(directory, name), metadata = lstatSync(filename);
    assert.ok(!metadata.isSymbolicLink(), 'Native addon source cannot contain links');
    if (metadata.isDirectory()) Object.assign(result, sourceFiles(filename, prefix + name + '/'));
    else { assert.ok(metadata.isFile()); result[prefix + name] = digest(readFileSync(filename)); }
  }
  return result;
}

function currentIdentity(arch) {
  assert.equal(arch, process.arch, 'Cached native SQLite must be built and loaded on its target architecture');
  const builder = createRequire(require.resolve('electron-builder'));
  const rebuild = createRequire(builder.resolve('@electron/rebuild'));
  const { getAbi } = rebuild('node-abi');
  const electron = require('electron/package.json').version;
  const module = path.dirname(require.resolve('better-sqlite3/package.json'));
  const environment = Object.fromEntries(['CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'GYP_DEFINES', 'GYP_MSVS_VERSION',
    'npm_config_build_from_source', 'npm_config_disturl', 'npm_config_msvs_version'].map(name => [name, process.env[name] ?? '']));
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installations = JSON.parse(execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'], { encoding: 'utf8' }));
  assert.equal(installations.length, 1, 'A concrete Visual Studio toolchain is required');
  const compiler = { visualStudio: installations[0].installationVersion,
    msvc: readFileSync(path.join(installations[0].installationPath, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim(),
    windowsSDKs: readdirSync(path.join(process.env['ProgramFiles(x86)'], 'Windows Kits/10/Include')).sort() };
  const settings = {};
  for (const name of ['scripts/electron-native-cache.mjs', 'electron-builder.yml']) settings[name] = digest(readFileSync(path.join(desktop, name)));
  return { module, electron, abi: String(getAbi(electron, 'electron')), identity: {
    platform: process.platform, arch, electron, abi: String(getAbi(electron, 'electron')), node: process.version,
    image: process.env.ImageOS, imageVersion: process.env.ImageVersion, compiler, environment,
    builder: builder('app-builder-lib/package.json').version,
    rebuild: JSON.parse(readFileSync(path.resolve(path.dirname(builder.resolve('@electron/rebuild')), '../package.json'), 'utf8')).version,
    source: sourceFiles(module), settings,
  } };
}

export function restoreElectronNativeCache(directory, destination, key) {
  if (!existsSync(directory) || readdirSync(directory).length === 0) return false;
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
  assert.deepEqual(readdirSync(directory).sort(), [...files, 'receipt.json'].sort(), 'Unexpected Electron native cache files');
  const receipt = JSON.parse(readFileSync(path.join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.key, key, 'Electron native build inputs changed');
  assert.deepEqual(Object.keys(receipt.files).sort(), files);
  for (const name of files) {
    const filename = path.join(directory, name), metadata = lstatSync(filename);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    assert.equal(digest(readFileSync(filename)), receipt.files[name], 'Corrupt Electron native output: ' + name);
  }
  mkdirSync(destination, { recursive: true });
  for (const name of files) copyFileSync(path.join(directory, name), path.join(destination, name));
  return true;
}

export function sealElectronNativeCache(directory, source, key) {
  assert.ok(!existsSync(directory) || readdirSync(directory).length === 0, 'Do not overwrite an existing native cache');
  mkdirSync(directory, { recursive: true });
  const hashes = {};
  for (const name of files) {
    const filename = path.join(source, name), metadata = lstatSync(filename);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    hashes[name] = digest(readFileSync(filename));
    copyFileSync(filename, path.join(directory, name));
  }
  writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify({ schema: 1, key, files: hashes }) + '\n', { flag: 'wx' });
}

export function prepareElectronNativeModules(arch, rebuild) {
  const directory = process.env.LEGALWORK_ELECTRON_NATIVE_CACHE;
  if (!directory) { rebuild(); return; }
  const current = currentIdentity(arch), key = electronNativeCacheKey(current.identity);
  assert.equal(key, process.env.LEGALWORK_ELECTRON_NATIVE_KEY, 'Installed Electron native build identity changed');
  const destination = path.join(current.module, 'build/Release');
  const hit = restoreElectronNativeCache(directory, destination, key);
  rebuild();
  assert.equal(readFileSync(path.join(destination, '.forge-meta'), 'utf8'), `${arch}--${current.abi}`);
  // Stock Electron's Node mode exercises the actual Electron ABI, without a
  // GUI, before packaging applies the product's runAsNode=false fuse.
  execFileSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict');
    assert.equal(process.versions.electron, ${JSON.stringify(current.electron)});
    assert.equal(process.versions.modules, ${JSON.stringify(current.abi)});
    const Database = require(${JSON.stringify(current.module)});
    const database = new Database(':memory:');
    database.exec('CREATE TABLE native_cache_test (value TEXT NOT NULL)');
    database.prepare('INSERT INTO native_cache_test VALUES (?)').run('electron-native-ok');
    assert.equal(database.prepare('SELECT value FROM native_cache_test').get().value, 'electron-native-ok');
    database.close();
    console.log('PASS: cached SQLite loads and queries under Electron ' + process.versions.electron + ' ABI ' + process.versions.modules);
  `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (!hit) sealElectronNativeCache(directory, destination, key);
  console.log(`Verified Electron native cache: ${key}; hit=${hit}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, arch = process.arch] = process.argv.slice(2);
  if (operation === 'key') {
    const key = electronNativeCacheKey(currentIdentity(arch).identity);
    const directory = path.join(process.env.RUNNER_TEMP, 'electron-native-sqlite');
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\ndirectory=${directory}\n`);
    appendFileSync(process.env.GITHUB_ENV, `LEGALWORK_ELECTRON_NATIVE_CACHE=${directory}\nLEGALWORK_ELECTRON_NATIVE_KEY=${key}\n`);
    console.log('Electron native cache key: ' + key);
  } else {
    assert.equal(operation, 'prepare');
    prepareElectronNativeModules(arch, () => execFileSync('pnpm.cmd', ['exec', 'electron-builder', 'install-app-deps', `--arch=${arch}`],
      { cwd: desktop, shell: true, stdio: 'inherit' }));
  }
}
