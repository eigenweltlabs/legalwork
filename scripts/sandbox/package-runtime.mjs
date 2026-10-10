/** Bundle QEMU and its dependencies. No package manager is required at runtime. */
import { peImports } from './pe-imports.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(process.argv[2] ?? '');
const destination = resolve(process.argv[3] ?? join(root, 'apps/server/resources/agent-sandbox/runtime'));
const architecture = basename(source).includes('aarch64') ? 'aarch64' : 'x86_64';
const extension = process.platform === 'win32' ? '.exe' : '';
const executable = `qemu-system-${architecture}${extension}`;
if (basename(source) !== executable) throw new Error(`Expected ${executable}`);
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr ?? result.error}`);
  return result.stdout;
}
const version = run(source, ['--version']).split('\n')[0];
if (!version.includes('11.1.2')) throw new Error(`Expected reviewed QEMU 11.1.2, got ${version}`);
if (process.platform === 'win32' && !/^whpx\s*$/m.test(run(source, ['-accel', 'help']))) {
  throw new Error('Windows QEMU must include Windows Hypervisor Platform acceleration');
}
mkdirSync(destination, { recursive: true });
for (const name of ['kernel', 'initrd.gz']) if (!existsSync(join(destination, name))) throw new Error(`Build the guest first: missing ${name}`);
const copied = new Map();
const packageRoots = new Set();
function bundle(original) {
  const name = basename(original), output = join(destination, name);
  const canonical = realpathSync(original);
  if (copied.has(name)) {
    if (copied.get(name) !== canonical) throw new Error(`Ambiguous runtime library ${name}`);
    return;
  }
  copied.set(name, canonical);
  const cellar = canonical.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//);
  if (cellar) packageRoots.add(cellar[1]);
  // Refuse an in-place copy so a developer cannot rewrite their system QEMU.
  if (existsSync(output) && realpathSync(output) === canonical) throw new Error(`Remove the development link before packaging: ${output}`);
  copyFileSync(canonical, output);
  chmodSync(output, 0o755);
  if (process.platform === 'darwin') {
    const dependencies = run('otool', ['-L', canonical]).split('\n').slice(1).map((line) => line.trim().split(' (')[0]).filter(Boolean);
    for (const dependency of dependencies) {
      if (dependency === canonical || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      if (!dependency.startsWith('/')) throw new Error(`Unresolved QEMU library: ${dependency}`);
      if (realpathSync(dependency) === canonical) continue;
      bundle(dependency);
      run('install_name_tool', ['-change', dependency, `@loader_path/${basename(dependency)}`, output]);
    }
    if (name.endsWith('.dylib')) run('install_name_tool', ['-id', `@loader_path/${name}`, output]);
  } else if (process.platform === 'win32') {
    for (const name of peImports(readFileSync(canonical))) {
      const dll = join(dirname(source), name);
      if (existsSync(dll)) bundle(dll);
      else if (!existsSync(join(process.env.SystemRoot, 'System32', name)) && !/^(api|ext)-ms-/i.test(name)) throw new Error(`Missing QEMU library ${name}`);
    }
  }
}
bundle(source);
const notices = ['LegalWork protected execution runtime',
  'QEMU 11.1.2 source: https://download.qemu.org/qemu-11.1.2.tar.xz',
  'Build scripts and modifications: scripts/sandbox and apps/server/resources/agent-sandbox in the LegalWork source tree.',
  'Windows package sources: https://mirror.msys2.org/mingw/sources/',
  'Guest package copyrights remain in /usr/share/doc inside the guest.'];
const sboms = [];
for (const directory of packageRoots) {
  notices.push(`\nPackage: ${basename(dirname(directory))} ${basename(directory)}`);
  for (const name of readdirSync(directory)) {
    if (/^(copying|license|licence|[al]?gpl|bsd|mit)/i.test(name) && statSync(join(directory, name)).isFile()) notices.push(name, readFileSync(join(directory, name), 'utf8'));
  }
  const sbom = join(directory, 'sbom.spdx.json');
  if (existsSync(sbom)) sboms.push(JSON.parse(readFileSync(sbom, 'utf8')));
}
function collectLicenses(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) collectLicenses(file);
    else if (entry.isFile()) notices.push(`${basename(directory)}/${entry.name}`, readFileSync(file, 'utf8'));
  }
}
if (process.platform === 'win32') collectLicenses(resolve(dirname(source), '../share/licenses'));
if (process.platform === 'linux' || (process.platform === 'darwin' && process.env.QEMU_SOURCE_DIR)) {
  if (!process.env.QEMU_SOURCE_DIR) throw new Error('QEMU_SOURCE_DIR is required to bundle the QEMU license');
  for (const name of ['COPYING', 'COPYING.LIB', 'LICENSE']) notices.push(name, readFileSync(join(process.env.QEMU_SOURCE_DIR, name), 'utf8'));
}
writeFileSync(join(destination, 'third-party-notices.txt'), notices.join('\n'));
writeFileSync(join(destination, 'third-party-sbom.json'), JSON.stringify(sboms, null, 2));
// Direct x86 kernel boot still needs SeaBIOS and its Linux loader ROM.
if (architecture === 'x86_64') {
  const data = process.env.QEMU_DATA_DIR ?? resolve(dirname(source), '../share/qemu');
  for (const name of ['bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin']) copyFileSync(join(data, name), join(destination, name));
}
if (process.platform === 'darwin') {
  const entitlements = join(root, 'scripts/sandbox/qemu-entitlements.plist');
  const identity = process.env.SANDBOX_SIGN_IDENTITY ?? '-';
  for (const name of [...copied.keys()].reverse()) run('codesign', ['--force', '--sign', identity,
    ...(identity === '-' ? [] : ['--options', 'runtime']), ...(name === executable ? ['--entitlements', entitlements] : []), join(destination, name)]);
}
const files = {};
for (const name of readdirSync(destination).sort()) {
  if (name === 'manifest.json') continue;
  files[name] = createHash('sha256').update(readFileSync(join(destination, name))).digest('hex');
}
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: 1, architecture, qemuVersion: '11.1.2', files }, null, 2) + '\n');
console.log(`Bundled ${executable} and ${copied.size - 1} libraries in ${destination}`);
