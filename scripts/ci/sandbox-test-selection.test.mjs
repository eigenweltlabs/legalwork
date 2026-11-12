import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sandboxRuntimeTestFiles, standaloneEngineTestFiles, serverUnitIgnorePatterns } from './sandbox-test-files.mjs';
import { engineTestFiles } from './run-engine-tests.mjs';
import { testArguments } from './run-tests.mjs';
import { changeScope } from './change-scope.mjs';

const server = fileURLToPath(new URL('../../apps/server/', import.meta.url));
const source = path.join(server, 'src');
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

test('every real VM fixture has one selected native or protected-engine home', () => {
  const selected = [...sandboxRuntimeTestFiles, ...standaloneEngineTestFiles];
  assert.equal(new Set(selected).size, selected.length);
  for (const file of selected) assert.ok(lstatSync(path.join(source, file)).isFile(), file);
  for (const file of testFiles(source)) {
    if (readFileSync(file, 'utf8').includes('LEGALWORK_SANDBOX_INTEGRATION')) {
      const name = path.relative(source, file).split(path.sep).join('/');
      assert.ok(selected.includes(name), `VM fixture would be skipped by every suite: ${name}`);
    }
  }
  const engine = new Set(engineTestFiles(source));
  for (const file of selected) assert.ok(!engine.has(path.join(source, file)), `Duplicate native/standalone engine fixture: ${file}`);
  for (const file of ['host.test.ts', 'raw-http-node.test.ts', 'raw-http-proxy.test.ts', 'filesystem.test.ts']) {
    assert.ok(sandboxRuntimeTestFiles.includes('agent-sandbox/' + file));
  }
  for (const file of ['agent-sandbox/permissions.test.ts', 'agent-sandbox/paths.test.ts', 'agent-sandbox/service.test.ts', 'approvals.test.ts', 'calculations/calculations.test.ts', 'skill-package.test.ts']) {
    assert.ok(!sandboxRuntimeTestFiles.includes(file));
    assert.ok(!serverUnitIgnorePatterns.includes('**/' + file));
  }
});

test('native validation is serial, explicit, and cannot pass with the VM flag absent', () => {
  assert.throws(() => testArguments('sandbox'), /explicit file list/);
  assert.throws(() => testArguments('sandbox', ['fixture.test.ts'], 2), /serially/);
  const args = testArguments('sandbox', ['fixture.test.ts']);
  assert.ok(!args.some(value => value.startsWith('--parallel')));
  assert.ok(args.includes('180000'));
  const script = fileURLToPath(new URL('./run-sandbox-tests.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script], { env: { ...process.env, LEGALWORK_SANDBOX_INTEGRATION: '' }, stdio: 'pipe' }), /Enable real sandbox integration/);
});

test('Bun unit discovery excludes every native file while retaining portable sandbox tests', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sandbox-unit-selection-'));
  try {
    const portable = path.join(directory, 'src/agent-sandbox/permissions.test.ts');
    mkdirSync(path.dirname(portable), { recursive: true });
    writeFileSync(portable, 'import {test,expect} from "bun:test";test("portable policy remains selected",()=>expect(2+2).toBe(4));');
    for (const file of [...sandboxRuntimeTestFiles, ...standaloneEngineTestFiles]) {
      const target = path.join(directory, 'src', file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'throw new Error("Native or standalone fixture was duplicated in the unit suite");');
    }
    const bun = process.env.LEGALWORK_TEST_BUN_BIN || 'bun';
    const options = { cwd: directory, env: { ...process.env, LEGALWORK_TEST_PREPARED: '1' }, encoding: 'utf8' };
    const result = spawnSync(bun, testArguments('server', [], 1), options);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /1 pass/);
    const unfiltered = spawnSync(bun, ['test', './src/'], options);
    assert.notEqual(unfiltered.status, 0, 'Negative control must execute and reject the duplicate native fixtures');
    assert.ok(!testArguments('server', ['src/agent-sandbox/host.test.ts'], 1).some(value => value.startsWith('--path-ignore-patterns')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('test-selection changes select the suites they control', () => {
  for (const file of ['scripts/ci/sandbox-test-files.mjs', 'scripts/ci/run-sandbox-tests.mjs', 'scripts/ci/run-tests.mjs']) {
    const selected = changeScope([file]);
    for (const field of ['units', 'server', 'engine', 'sandbox']) assert.equal(selected[field], true, `${file}: ${field}`);
  }
  assert.equal(changeScope(['scripts/ci/run-engine-tests.mjs']).engine, true);
});
