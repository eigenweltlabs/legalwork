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
import { contractTests, engineTestContracts } from './engine-test-contracts.mjs';

const fixtureContracts = [{inputs: /apps\/server\/src\/(watcher|server)\.ts$/, tests: /(?:aliases|connector)\.integration\.test\.ts$/}];

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
    put('apps/server/src/url-loaded.integration.test.ts', 'import { binary } from "./native.test-support.js"; const entry = new URL("./plugin.ts", import.meta.url);');
    const initial = commit();
    return run({ root, put, commit, initial });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('portable imports resolve without installations and native contracts select their declared fixtures', () => fixture(({ root }) => {
  const graph = testDependencies('server', { root });
  const expected = ['apps/server/src/aliases.integration.test.ts', 'apps/server/src/connector.integration.test.ts'];
  assert.deepEqual(graph.affected(['apps/server/src/watcher.ts']), expected);
  assert.deepEqual(graph.affected(['packages/types/src/capability.ts']), [expected[0]]);
  assert.deepEqual(graph.affected(['packages/types/package.json']), [expected[0]]);
  assert.deepEqual(graph.affected(['apps/server/tsconfig.json']), graph.tests);
  const selection = engineTestSelection(['apps/server/src/watcher.ts'], { root, contracts:fixtureContracts });
  assert.deepEqual(selection.affectedEngineTests, expected);
  assert.ok(selection.realTests.includes('apps/server/src/url-loaded.integration.test.ts'), 'An imported engine helper declares the native requirement');
  assert.ok(!selection.realTests.includes('apps/server/src/unrelated.test.ts'));
  assert.deepEqual(mergePlan(['apps/server/src/watcher.ts'], { engineDepsChanged: false, ...selection }).focused, expected);
}));

test('literal plugin and fixture URLs participate in the same input graph', () => fixture(({ root }) => {
  assert.deepEqual(engineTestSelection(['apps/server/src/plugin.ts'], { root }).affectedEngineTests,
    ['apps/server/src/url-loaded.integration.test.ts']);
}));

test('pinned replay graphs use that revision even when the current source connections changed', () => fixture(({ root, put, commit, initial }) => {
  put('apps/server/src/connector.integration.test.ts', 'import { unrelated } from "./unrelated.js";');
  commit();
  assert.ok(testDependencies('server',{root,ref:initial}).affected(['apps/server/src/watcher.ts']).includes('apps/server/src/connector.integration.test.ts'));
  assert.ok(engineTestSelection([], {root,ref:initial}).realTests.includes('apps/server/src/connector.integration.test.ts'));
  assert.ok(!testDependencies('server',{root}).affected(['apps/server/src/watcher.ts']).includes('apps/server/src/connector.integration.test.ts'));
  assert.ok(!engineTestSelection([], {root}).realTests.includes('apps/server/src/connector.integration.test.ts'));
}));

test('unknown or deleted native inputs conservatively retain the full engine gate', () => fixture(({ root }) => {
  const selection = engineTestSelection(['apps/server/src/deleted.ts'], { root, contracts:fixtureContracts });
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

test('portable type dependencies do not declare a native engine requirement', () => fixture(({root,put}) => {
  put('apps/server/src/type-only.test.ts', 'import type { binary } from "./native.test-support.js";');
  assert.ok(!engineTestSelection(['apps/server/src/watcher.ts'], {root}).realTests.includes('apps/server/src/type-only.test.ts'));
}));

test('new native fixtures must declare an engine contract', () => {
  const {realTests}=engineTestSelection([]);
  assert.deepEqual(realTests.filter(file=>!engineTestContracts.some(contract=>contract.tests.test(file))),[]);
});

test('ordinary routes and shared portable fields do not inherit all server engine fixtures', () => fixture(({root,put}) => {
  put('apps/server/src/routes/files.ts', 'export const route = true;');
  put('apps/server/src/server.ts', 'import {route} from "./routes/files.js"; export const server = route;');
  assert.deepEqual(engineTestSelection(['apps/server/src/routes/files.ts'],{root}).affectedEngineTests,[]);
  assert.ok(engineTestSelection(['apps/server/src/server.ts'],{root}).affectedEngineTests.includes('apps/server/src/connector.integration.test.ts'));
}));

test('package license files and a new unused export do not change engine consumers', () => fixture(({root,put,commit,initial}) => {
  put('apps/server/package.json',JSON.stringify({type:'module',files:['dist','resources/licenses']}));
  put('packages/types/package.json',JSON.stringify({name:'@legalwork/types',exports:{'./capability':'./src/capability.ts','./new-feature':'./src/new-feature.ts'}}));
  put('packages/types/src/new-feature.ts','export const value = true;');
  const ref=commit();
  const result=engineTestSelection(['apps/server/package.json','packages/types/package.json'],{root,base:initial,ref});
  assert.deepEqual(result.affectedEngineTests,[]);
  assert.equal(result.engineInputsUnknown,false);
  put('packages/types/src/replacement.ts','export const capability = false;');
  put('packages/types/package.json',JSON.stringify({name:'@legalwork/types',exports:{'./capability':'./src/replacement.ts'}}));
  const changed=engineTestSelection(['packages/types/package.json'],{root,base:initial,ref:commit()});
  assert.ok(changed.affectedEngineTests.includes('apps/server/src/aliases.integration.test.ts'));
}));

test('patches retain their owners and server runtime patches retain native consumers', () => fixture(({root,put,commit}) => {
  put('apps/desktop/package.json',JSON.stringify({name:'desktop',dependencies:{'electron-updater':'6.8.3'}}));
  put('apps/app/package.json',JSON.stringify({name:'app',dependencies:{'@eigenpal/docx-editor-core':'1.8.3'}}));
  put('apps/server/package.json',JSON.stringify({type:'module',dependencies:{'native-package':'1.0.0'}}));
  put('apps/server/src/package.integration.test.ts','import {binary} from "./native.test-support.js"; import "native-package";');
  const base=commit();
  put('patches/electron-updater@6.8.3.patch','patch');
  put('patches/@eigenpal__docx-editor-core@1.8.3.patch','patch');
  put('patches/native-package@1.0.0.patch','patch');
  const ref=commit();
  for(const patch of ['patches/electron-updater@6.8.3.patch','patches/@eigenpal__docx-editor-core@1.8.3.patch']) {
    const result=engineTestSelection([patch],{root,base,ref});
    assert.equal(result.engineInputsUnknown,false);
    assert.deepEqual(result.affectedEngineTests,[]);
  }
  assert.deepEqual(engineTestSelection(['patches/native-package@1.0.0.patch'],{root,base,ref}).affectedEngineTests,['apps/server/src/package.integration.test.ts']);
  assert.equal(engineTestSelection(['patches/unknown@1.0.0.patch'],{root,base,ref}).engineInputsUnknown,true);
}));

test('deleted native subjects use the base graph and compiler settings retain full verification', () => fixture(({root,commit,initial}) => {
  rmSync(path.join(root,'apps/server/src/plugin.ts'));
  const result=engineTestSelection(['apps/server/src/plugin.ts'],{root,base:initial,ref:commit()});
  assert.equal(result.engineInputsUnknown,false);
  assert.deepEqual(result.affectedEngineTests,['apps/server/src/url-loaded.integration.test.ts']);
  assert.equal(engineTestSelection(['apps/server/tsconfig.json'],{root}).engineInputsUnknown,true);
}));

test('critical indirect native subjects retain their actual contracts', () => {
  for(const [input,expected] of [
    ['reload-watcher.ts','plugin-create-refresh.test.ts'],
    ['native-opencode-config.ts','scheduled-tasks/engine.test.ts'],
    ['native-command-control.ts','opencode-plugins/legalwork-sandbox.released.test.ts'],
    ['legacy-mcp-credentials.ts','legacy-mcp-lifecycle.released.test.ts'],
    ['routes/engine-project.ts','managed-engine-lifecycle.released.test.ts'],
    ['opencode-plugins/legalwork-storage-tools.ts','opencode-plugins/pdf-reading.integration.test.ts'],
  ]) {
    const result=engineTestSelection(['apps/server/src/'+input]);
    assert.equal(result.engineInputsUnknown,false,input+' must have declared coverage');
    assert.ok(result.affectedEngineTests.includes('apps/server/src/'+expected),input+' needs '+expected);
  }
});

test('split type and value imports preserve runtime edges', () => fixture(({root,put}) => {
  put('apps/server/src/mixed.test.ts', 'import type {binary as Binary} from "./native.test-support.js"; import {binary} from "./native.test-support.js";');
  put('apps/server/src/inline.test.ts', 'import {type binary} from "./native.test-support.js";');
  const graph=testDependencies('server',{root,runtimeOnly:true});
  assert.ok(graph.affected(['apps/server/src/native.test-support.ts']).includes('apps/server/src/mixed.test.ts'));
  assert.ok(!graph.affected(['apps/server/src/native.test-support.ts']).includes('apps/server/src/inline.test.ts'));
}));

test('native-owned shared schemas retain engine checks without including unrelated barrels', () => {
  const {realTests}=engineTestSelection([]);
  for(const name of ['native-model-display','model-limits','engine-project','session-history','org-policy']) {
    assert.ok(contractTests(['packages/types/src/'+name+'.ts'],realTests).length>0,name);
  }
  for(const name of ['connectors','workspace','project-templates','chat-tool-results']) {
    assert.deepEqual(contractTests(['packages/types/src/'+name+'.ts'],realTests),[],name);
  }
});

test('editing a single native fixture does not select every fixture in its component', () => {
  const tests=['apps/server/src/mcp.oauth-flow.e2e.test.ts','apps/server/src/mcp.oauth-rebuild.e2e.test.ts'];
  assert.deepEqual(contractTests([tests[0]],tests),[tests[0]]);
});

test('wildcard export resolution changes select their existing native consumer', () => fixture(({root,put,commit}) => {
  put('packages/types/package.json',JSON.stringify({name:'@legalwork/types',exports:{'./*':'./src/*.ts'}}));
  const base=commit();
  put('packages/types/src/next/capability.ts','export const capability = true;');
  put('packages/types/package.json',JSON.stringify({name:'@legalwork/types',exports:{'./*':'./src/next/*.ts'}}));
  const result=engineTestSelection(['packages/types/package.json'],{root,base,ref:commit()});
  assert.ok(result.affectedEngineTests.includes('apps/server/src/aliases.integration.test.ts'));
}));
