/** CI/build tooling only. Installed LegalWork never invokes Docker. */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const arch = process.argv[2] ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Guest architecture must be arm64 or x64');
const destination = resolve(process.argv[3] ?? `${root}/apps/server/resources/agent-sandbox/runtime`);
const image = `legalwork-sandbox-guest:${arch}`;
function run(args, capture = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`Guest build failed: ${result.stderr ?? result.error ?? args[0]}`);
  return result.stdout?.trim();
}
run(['build', '--platform', `linux/${arch === 'x64' ? 'amd64' : 'arm64'}`, '--tag', image,
  resolve(root, 'apps/server/resources/agent-sandbox')]);
mkdirSync(destination, { recursive: true });
const container = run(['create', image], true);
try { run(['cp', `${container}:/out/.`, destination]); }
finally { run(['rm', container]); }
