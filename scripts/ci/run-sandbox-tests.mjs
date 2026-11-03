import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandboxRuntimeTestFiles } from './sandbox-test-files.mjs';
import { runTests } from './run-tests.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.LEGALWORK_SANDBOX_INTEGRATION, '1', 'Enable real sandbox integration before selecting the native suite');
  const files = sandboxRuntimeTestFiles.map(file => fileURLToPath(new URL(`../../apps/server/src/${file}`, import.meta.url)));
  for (const file of files) assert.ok(lstatSync(file).isFile(), `Missing native sandbox test: ${file}`);
  process.exitCode = runTests('sandbox', files);
}
