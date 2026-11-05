/** Exercise the installed runtime with the Node executable shipped beside it. */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const application = resolve(process.argv[2]);
const appBundle = application.endsWith('.app') ? application
  : basename(dirname(application)) === 'MacOS' && basename(dirname(dirname(application))) === 'Contents'
    && dirname(dirname(dirname(application))).endsWith('.app') ? dirname(dirname(dirname(application))) : undefined;
const parent = realpathSync(appBundle ?? dirname(application));
if (!application.endsWith('.app')) {
  const expected = appBundle ? join(parent, 'Contents', 'MacOS', basename(application)) : join(parent, basename(application));
  if (realpathSync(application) !== expected) throw new Error('The packaged executable escapes its package.');
}
const expectedResources = appBundle ? join(parent, 'Contents', 'Resources') : join(parent, 'resources');
const resources = realpathSync(expectedResources);
if (resources !== expectedResources) throw new Error('The packaged resources directory escapes its package.');
const expectedNode = join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const node = realpathSync(expectedNode);
if (node !== expectedNode) throw new Error('The bundled Node executable escapes its package.');
const probe = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const result = spawnSync(node, [probe, join(resources, 'agent-sandbox')], { stdio: 'inherit', timeout: 300000, windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Packaged sandbox probe failed (${result.status})`);
