import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = name => /^[a-zA-Z0-9_.+-]+$/.test(name);

export function sandboxCacheKey(kind, arch, repository = root) {
  assert.ok(['guest', 'runtime'].includes(kind));
  assert.ok(['x64', 'arm64'].includes(arch));
  const names = execFileSync('git', ['ls-files', '-z', '--', 'scripts/sandbox', 'apps/server/resources/agent-sandbox',
    'scripts/ci/cache-sandbox-runtime.mjs', '.github/workflows/sandbox-runtime.yml'], { cwd: repository, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const inputs = Object.fromEntries(names.filter(name => !name.includes('/runtime/') && !/\.test\.[cm]?[jt]s$/.test(name))
    .map(name => [name, hash(readFileSync(path.join(repository, name)))]));
  const identity = { version: 1, kind, arch, platform: process.platform,
    image: process.env.ImageOS ?? 'local', imageVersion: process.env.ImageVersion ?? 'local', inputs };
  return `sandbox-${kind}-v1-${process.platform}-${arch}-${hash(JSON.stringify(identity))}`;
}

export function verifyRuntimeCache(directory, key, kind, arch) {
  const receipt = JSON.parse(readFileSync(path.join(directory, '.ci-cache-receipt.json'), 'utf8'));
  assert.equal(receipt.key, key, 'Runtime cache source/toolchain identity changed');
  const names = readdirSync(directory).filter(name => name !== '.ci-cache-receipt.json').sort();
  assert.deepEqual(names, Object.keys(receipt.files).sort(), 'Unexpected or missing cached runtime files');
  for (const name of names) {
    assert.ok(safeName(name), 'Invalid runtime filename');
    const filename = path.join(directory, name);
    assert.ok(lstatSync(filename).isFile(), 'Cached runtime entries must be ordinary files');
    assert.equal(hash(readFileSync(filename)), receipt.files[name], `Runtime cache corruption: ${name}`);
  }
  for (const name of ['kernel', 'initrd.gz']) assert.ok(receipt.files[name], `Missing guest ${name}`);
  if (kind === 'runtime') {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.architecture, arch === 'arm64' ? 'aarch64' : 'x86_64');
    assert.equal(manifest.qemuVersion, '11.1.2');
    for (const name of ['third-party-notices.txt', 'third-party-sbom.json']) assert.ok(manifest.files[name], `Missing license resource ${name}`);
    for (const [name, digest] of Object.entries(manifest.files)) assert.equal(receipt.files[name], digest, `Runtime manifest mismatch: ${name}`);
  }
  return receipt;
}

export function writeRuntimeReceipt(directory, key) {
  const files = {};
  for (const name of readdirSync(directory).sort()) {
    if (name === '.ci-cache-receipt.json') continue;
    assert.ok(safeName(name) && lstatSync(path.join(directory, name)).isFile(), 'Runtime cache must contain ordinary named files');
    files[name] = hash(readFileSync(path.join(directory, name)));
  }
  writeFileSync(path.join(directory, '.ci-cache-receipt.json'), JSON.stringify({ version: 1, key, files }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, kind, arch, directory = path.join(root, 'apps/server/resources/agent-sandbox/runtime')] = process.argv.slice(2);
  const key = sandboxCacheKey(kind, arch);
  if (operation === 'key') {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
    console.log(key);
  } else if (operation === 'seal') writeRuntimeReceipt(directory, key);
  else if (operation === 'verify') verifyRuntimeCache(directory, key, kind, arch);
  else throw new Error('Use key|seal|verify guest|runtime x64|arm64 [directory]');
}
