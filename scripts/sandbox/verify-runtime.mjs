import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = process.argv[2] ?? fileURLToPath(new URL('../../apps/server/resources/agent-sandbox/runtime/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || !['aarch64', 'x86_64'].includes(manifest.architecture)) throw new Error('Invalid sandbox manifest');
const extension = process.platform === 'win32' ? '.exe' : '';
for (const name of ['kernel', 'initrd.gz', `qemu-system-${manifest.architecture}${extension}`]) {
  if (!manifest.files[name]) throw new Error(`Missing sandbox resource: ${name}`);
}
for (const [name, expected] of Object.entries(manifest.files)) {
  if (!/^[a-zA-Z0-9_.+-]+$/.test(name)) throw new Error('Invalid sandbox resource name');
  const actual = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
  if (actual !== expected) throw new Error(`Sandbox resource checksum mismatch: ${name}`);
}
console.log(`Verified bundled ${manifest.architecture} sandbox resources`);
