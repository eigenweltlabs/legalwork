// Server source tests declare real-engine fixtures through this environment
// variable. The normal unit job leaves it unset; this job must execute them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function engineTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return engineTestFiles(filename);
    return entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      && readFileSync(filename, 'utf8').includes('LEGALWORK_TEST_OPENCODE_BIN') ? [filename] : [];
  }).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.LEGALWORK_TEST_OPENCODE_BIN, 'Set up the verified engine before running integration tests');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = engineTestFiles(path.join(root, 'apps/server/src'));
  assert.ok(files.length > 0, 'No declared server engine tests found');
  console.log(`Running ${files.length} server test files with the verified engine.`);
  const result = spawnSync('bun', ['test', '--preload', './apps/server/test-preload.ts', '--timeout', '180000', ...files], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
