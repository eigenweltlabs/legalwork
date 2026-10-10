/** Exercise the installed runtime with the Node executable shipped beside it. */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const application = resolve(process.argv[2]);
const resources = application.endsWith('.app')
  ? join(application, 'Contents', 'Resources') : join(dirname(application), 'resources');
const node = join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const probe = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const result = spawnSync(node, [probe, join(resources, 'agent-sandbox')], { stdio: 'inherit', timeout: 300000, windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Packaged sandbox probe failed (${result.status})`);
