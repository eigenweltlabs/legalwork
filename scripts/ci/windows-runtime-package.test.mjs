import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('../sandbox/package-runtime.mjs', import.meta.url));

// A minimal PE32+ file exercises the real import reader and recursive copier.
function pe(imports) {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  const section = 0x98 + 240;
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0xe00, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  if (imports.length) {
    bytes.writeUInt32LE(0x1000, 0x98 + 112 + 8);
    bytes.writeUInt32LE((imports.length + 1) * 20, 0x98 + 112 + 12);
    for (const [index, name] of imports.entries()) {
      bytes.writeUInt32LE(0x1200 + index * 128, 0x200 + index * 20 + 12);
      bytes.write(name + '\0', 0x400 + index * 128, 'ascii');
    }
  }
  return bytes;
}

function fixture(architecture, run, { sdl = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legalwork-windows-runtime-'));
  const bin = join(root, 'bin'), destination = join(root, 'runtime');
  mkdirSync(bin); mkdirSync(destination);
  const executable = `qemu-system-${architecture}.exe`;
  writeFileSync(join(bin, executable), pe(sdl ? ['SDL2.dll'] : []));
  if (sdl) {
    writeFileSync(join(bin, 'SDL2.dll'), pe([]));
    writeFileSync(join(bin, 'SDL3.dll'), pe(['libwinpthread-1.dll']));
    writeFileSync(join(bin, 'libwinpthread-1.dll'), pe([]));
  }
  for (const name of ['kernel', 'initrd.gz', 'legalwork-host.exe']) writeFileSync(join(destination, name), name);
  const data = join(root, 'share', 'qemu');
  mkdirSync(data, { recursive: true });
  for (const name of ['bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin']) writeFileSync(join(data, name), name);
  const preload = join(root, 'preload.mjs');
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    import child from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    child.spawnSync = (command, args) => {
      assert.equal(command, ${JSON.stringify(join(bin, executable))});
      if (args[0] === '--version') return { status: 0, stdout: 'QEMU emulator version 11.1.2\\n' };
      assert.deepEqual(args, ['-accel', 'help']);
      return { status: 0, stdout: 'Accelerators supported in QEMU binary:\\nwhpx\\ntcg\\n' };
    };
    syncBuiltinESMExports();
  `);
  const invoke = () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, join(bin, executable), destination], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, SystemRoot: join(root, 'windows') },
  });
  try { run({ bin, destination, invoke }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

for (const architecture of ['x86_64', 'aarch64']) {
  test(`Windows ${architecture} bundles SDL3 and its dependency closure outside the SDL2 import table`, () => fixture(architecture, f => {
    const result = f.invoke();
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(f.destination, 'manifest.json'), 'utf8'));
    for (const name of ['SDL2.dll', 'SDL3.dll', 'libwinpthread-1.dll']) {
      assert.ok(existsSync(join(f.destination, name)), `Missing dynamically loaded runtime dependency: ${name}`);
      assert.deepEqual(readFileSync(join(f.destination, name)), readFileSync(join(f.bin, name)));
      assert.equal(manifest.files[name], createHash('sha256').update(readFileSync(join(f.bin, name))).digest('hex'));
    }
  }));
}

test('a missing SDL3 dependency fails packaging before writing a manifest', () => fixture('aarch64', f => {
  rmSync(join(f.bin, 'SDL3.dll'));
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDL3\.dll/);
  assert.equal(existsSync(join(f.destination, 'manifest.json')), false);
}));

test('a Windows build without SDL2 does not require SDL3', () => fixture('aarch64', f => {
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.destination, 'SDL3.dll')), false);
}, { sdl: false }));
