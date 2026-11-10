import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { testDependencies } from './test-dependencies.mjs';
import { engineTestSelection } from './run-engine-tests.mjs';
import { mergePlan } from './merge-plan.mjs';

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'test-dependencies-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const put = (file, source) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), source); };
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    put('apps/server/package.json', JSON.stringify({ type: 'module' }));
    put('apps/server/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
    put('apps/server/src/watcher.ts', 'export const watched = true;');
    put('apps/server/src/server.ts', 'export { watched } from "./watcher.js";');
    put('apps/server/src/native.test-support.ts', 'export const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;');
    put('apps/server/src/connector.integration.test.ts', 'import { watched } from "./server.js"; import { binary } from "./native.test-support.js";');
    put('apps/server/src/unrelated.ts', 'export const unrelated = true;');
    put('apps/server/src/unrelated.test.ts', 'import { unrelated } from "./unrelated.js";');
    put('packages/types/package.json', JSON.stringify({ name: '@legalwork/types', exports: { './capability': './src/capability.ts' } }));
    put('packages/types/src/capability.ts', 'export const capability = true;');
    put('apps/server/src/aliases.integration.test.ts', 'import { watched } from "@/server.js"; import { capability } from "@legalwork/types/capability"; import { binary } from "./native.test-support.js";');
    put('apps/server/src/plugin.ts', 'export default () => {};');
    put('apps/server/src/plugin.integration.test.ts', 'import { binary } from "./native.test-support.js"; const entry = new URL("./plugin.ts", import.meta.url);');
    const initial = commit();
    return run({ root, put, commit, initial });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('both selectors follow transitive imports, aliases and workspace exports without workspace installations', () => fixture(({ root }) => {
  const graph = testDependencies('server', { root });
  const expected = ['apps/server/src/aliases.integration.test.ts', 'apps/server/src/connector.integration.test.ts'];
  assert.deepEqual(graph.affected(['apps/server/src/watcher.ts']), expected);
  assert.deepEqual(graph.affected(['packages/types/src/capability.ts']), [expected[0]]);
  assert.deepEqual(graph.affected(['packages/types/package.json']), [expected[0]]);
  assert.deepEqual(graph.affected(['apps/server/tsconfig.json']), graph.tests);
  const selection = engineTestSelection(['apps/server/src/watcher.ts'], { root });
  assert.deepEqual(selection.affectedEngineTests, expected);
  assert.ok(selection.realTests.includes('apps/server/src/plugin.integration.test.ts'), 'An imported engine helper declares the native requirement');
  assert.ok(!selection.realTests.includes('apps/server/src/unrelated.test.ts'));
  assert.deepEqual(mergePlan(['apps/server/src/watcher.ts'], { engineDepsChanged: false, ...selection }).focused, expected);
}));

test('literal plugin and fixture URLs participate in the same input graph', () => fixture(({ root }) => {
  assert.deepEqual(engineTestSelection(['apps/server/src/plugin.ts'], { root }).affectedEngineTests,
    ['apps/server/src/plugin.integration.test.ts']);
}));

test('pinned replay graphs use that revision even when the current source connections changed', () => fixture(({ root, put, commit, initial }) => {
  put('apps/server/src/connector.integration.test.ts', 'import { unrelated } from "./unrelated.js"; import { binary } from "./native.test-support.js";');
  commit();
  assert.ok(engineTestSelection(['apps/server/src/watcher.ts'], { root, ref: initial }).affectedEngineTests.includes('apps/server/src/connector.integration.test.ts'));
  assert.ok(!engineTestSelection(['apps/server/src/watcher.ts'], { root }).affectedEngineTests.includes('apps/server/src/connector.integration.test.ts'));
}));

test('unknown or deleted native inputs conservatively retain the full engine gate', () => fixture(({ root }) => {
  const selection = engineTestSelection(['apps/server/src/deleted.ts'], { root });
  assert.equal(selection.engineInputsUnknown, true);
  assert.deepEqual(selection.affectedEngineTests, selection.realTests);
  assert.equal(mergePlan(['apps/server/src/deleted.ts'], { engineDepsChanged: false, ...selection }).fullEngine, true);
}));

test('isolated UI MCP planning stays dependency-free before workspace installation', () => fixture(({ root, put, commit, initial }) => {
  put('packages/legalwork-ui-mcp/index.mjs', 'export const changed = true;');
  const head = commit(), output = path.join(root, 'outputs'), summary = path.join(root, 'summary');
  execFileSync(process.execPath, [fileURLToPath(new URL('./merge-plan.mjs', import.meta.url))], { cwd: root, env: { ...process.env,
    NODE_PATH: '', EVENT_NAME: 'pull_request', BASE_SHA: initial, HEAD_SHA: head, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
  assert.match(readFileSync(output, 'utf8'), /^engine=false$/m);
}));

test('the existing reload watcher reaches native connector cases through the server', () => {
  const selection = engineTestSelection(['apps/server/src/reload-watcher.ts']);
  assert.ok(selection.affectedEngineTests.includes('apps/server/src/plugin-create-refresh.test.ts'));
  assert.ok(selection.realTests.includes('apps/server/src/provider-selection.released.test.ts'), 'Native fixtures importing an engine helper must not silently disappear');
  assert.equal(selection.engineInputsUnknown, false);
});
