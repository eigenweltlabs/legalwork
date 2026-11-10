// Server source tests declare real-engine fixtures through this environment
// variable. The normal unit job leaves it unset; this job must execute them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTests } from './run-tests.mjs';
import { standaloneEngineTestFiles } from './sandbox-test-files.mjs';
import { isTestInput, testDependencies } from './test-dependencies.mjs';

const standalone = new Set(standaloneEngineTestFiles.map(file => fileURLToPath(new URL(`../../apps/server/src/${file}`, import.meta.url))));

export function engineTestFiles(directory, dependencies) {
  if (dependencies) {
    const inputs = [...dependencies.sources].filter(([, source]) => source.includes('LEGALWORK_TEST_OPENCODE_BIN')).map(([file]) => file);
    return dependencies.affected(inputs).filter(file => file.startsWith('apps/server/src/')
      && !standaloneEngineTestFiles.some(name => file === 'apps/server/src/' + name))
      .map(file => path.resolve(directory, '..', file.replace(/^apps\/server\//, ''))).sort();
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return engineTestFiles(filename);
    return entry.isFile() && !standalone.has(filename) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      && readFileSync(filename, 'utf8').includes('LEGALWORK_TEST_OPENCODE_BIN') ? [filename] : [];
  }).sort();
}

export function engineTestSelection(changed, options = {}) {
  const root = options.root ?? process.cwd(), dependencies = testDependencies('server', options);
  const realTests = engineTestFiles(path.join(root, 'apps/server/src'), dependencies).map(file => path.relative(root, file).split(path.sep).join('/'));
  const inputs = changed.filter(file => isTestInput('server', file));
  const unknownInputs = inputs.filter(file => !dependencies.files.has(file));
  const affected = new Set(dependencies.affected(inputs));
  return { realTests, affectedEngineTests: unknownInputs.length ? realTests : realTests.filter(file => affected.has(file)),
    engineInputsUnknown: unknownInputs.length > 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.LEGALWORK_TEST_OPENCODE_BIN, 'Set up the verified engine before running integration tests');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = engineTestFiles(path.join(root, 'apps/server/src'), testDependencies('server', { root }));
  assert.ok(files.length > 0, 'No declared server engine tests found');
  console.log(`Running ${files.length} server test files with the verified engine.`);
  process.exitCode = runTests('engine', files);
}
