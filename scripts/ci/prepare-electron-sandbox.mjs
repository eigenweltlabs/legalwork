import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

export function prepareElectronSandbox({ platform = process.platform, loadElectron = () => require('electron'), stat = statSync, run = execFileSync } = {}) {
  if (platform !== 'linux') throw Error('ci_electron_sandbox_linux_required');
  // Electron can download lazily and print to stdout here. Keep the returned path in-process.
  const executable = loadElectron();
  if (typeof executable !== 'string' || !isAbsolute(executable)) throw Error('ci_electron_path_invalid');
  const sandbox = join(dirname(executable), 'chrome-sandbox');
  let regular = false;
  try { regular = stat(sandbox).isFile(); } catch { /* Fixed missing-file error below. */ }
  if (!regular) throw Error('ci_electron_sandbox_missing');
  run('sudo', ['chown', 'root:root', sandbox], { stdio: 'inherit' });
  run('sudo', ['chmod', '4755', sandbox], { stdio: 'inherit' });
  return sandbox;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('Prepared sandbox: ' + prepareElectronSandbox());
}
