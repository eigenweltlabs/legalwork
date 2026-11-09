import assert from 'node:assert/strict';
import { accessSync, constants, lstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandboxRuntimeTestFiles } from './sandbox-test-files.mjs';
import { runTests } from './run-tests.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.LEGALWORK_SANDBOX_INTEGRATION, '1', 'Enable real sandbox integration before selecting the native suite');
  const node = new URL('../../apps/desktop/resources/node/' + (process.platform === 'win32' ? 'node.exe' : 'node'), import.meta.url);
  try { accessSync(node, constants.X_OK); } catch (cause) {
    throw new Error('Prepare the pinned Node worker with node apps/desktop/scripts/prepare-node-runtime.mjs before running sandbox tests.', { cause });
  }
  const files = sandboxRuntimeTestFiles.map(file => fileURLToPath(new URL(`../../apps/server/src/${file}`, import.meta.url)));
  for (const file of files) assert.ok(lstatSync(file).isFile(), `Missing native sandbox test: ${file}`);
  process.exitCode = runTests('sandbox', files);
}
