import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installer = new URL('../sandbox/install-windows-qemu.sh', import.meta.url);
const pins = readFileSync(new URL('../sandbox/qemu-windows.sha256', import.meta.url), 'utf8');

function install(prefix, fault = '') {
  const root = mkdtempSync(join(tmpdir(), 'qemu-pins-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  copyFileSync(installer, join(root, 'install.sh'));
  // Small archives let the real checksum gate run without network or pacman.
  writeFileSync(join(root, 'qemu-windows.sha256'), pins.replace(/^\w+  (.+)$/gm, (_, name) =>
    `${createHash('sha256').update(name).digest('hex')}  ${name}`));
  const stub = (name, source) => writeFileSync(join(bin, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  stub('curl', `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2), url = args.find(arg => arg.startsWith('https://'));
    fs.appendFileSync(process.env.TRACE, JSON.stringify(['curl', url]) + '\\n');
    if (process.env.FAULT === 'download') process.exit(22);
    const name = path.basename(url);
    fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAULT === 'checksum' ? 'corrupt' : name);
  `);
  stub('pacman', `
    const fs = require('node:fs'), args = process.argv.slice(2);
    fs.appendFileSync(process.env.TRACE, JSON.stringify(['pacman', ...args]) + '\\n');
    if (args[0] === '-S' && args.some(arg => /-qemu/.test(arg))) process.exit(1);
    if (args[0] === '-U') for (const archive of args.filter(arg => arg.endsWith('.zst'))) {
      if (!fs.existsSync(archive + '.sig')) process.exit(1);
    }
  `);
  const trace = join(root, 'trace');
  writeFileSync(trace, '');
  try {
    const result = spawnSync('bash', [join(root, 'install.sh'), prefix], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace, FAULT: fault }, encoding: 'utf8',
    });
    return { ...result, calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const [prefix, packageName] of [['ucrt64', 'mingw-w64-ucrt-x86_64'], ['clangarm64', 'mingw-w64-clang-aarch64']]) {
  test(`Windows ${prefix} installs the complete pinned QEMU release when the repository advances`, () => {
    const result = install(prefix);
    assert.equal(result.status, 0, result.stderr);
    const downloads = result.calls.filter(([command]) => command === 'curl').map(([, url]) => url);
    const expected = ['', '-common', '-guest-agent', '-image-util'].map(suffix =>
      `https://repo.msys2.org/mingw/${prefix}/${packageName}-qemu${suffix}-11.1.2-1-any.pkg.tar.zst`);
    assert.deepEqual(downloads, expected.flatMap(url => [url, `${url}.sig`]));
    const transactions = result.calls.filter(([command]) => command === 'pacman');
    assert.deepEqual(transactions[0], ['pacman', '-S', '--noconfirm', '--needed', `${packageName}-cc`]);
    assert.equal(transactions.length, 2);
    assert.deepEqual(transactions[1].slice(0, 4), ['pacman', '-U', '--noconfirm', '--needed']);
    assert.deepEqual(transactions[1].slice(4).map(path => path.split('/').at(-1)), expected.map(url => url.split('/').at(-1)));
  });
}

for (const fault of ['checksum', 'download']) {
  test(`A ${fault} failure stops before installing any packages`, () => {
    const result = install('ucrt64', fault);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.some(([command]) => command === 'pacman'), false);
  });
}

test('Unknown Windows environments fail before downloading or installing', () => {
  const result = install('unsupported');
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
});
