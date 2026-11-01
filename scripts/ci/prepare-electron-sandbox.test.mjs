import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { prepareElectronSandbox } from './prepare-electron-sandbox.mjs';

test('lazy Electron download output cannot enter sandbox permission arguments', () => {
  const calls = [];
  const executable = join(tmpdir(), 'runner with spaces', 'electron', 'dist', 'electron');
  const expected = join(dirname(executable), 'chrome-sandbox');
  const sandbox = prepareElectronSandbox({ platform: 'linux',
    loadElectron() { console.log('Downloading Electron binary...'); return executable; },
    stat(path) { assert.equal(path, expected); return { isFile: () => true }; },
    run(command, args, options) { calls.push({ command, args, options }); },
  });
  assert.equal(sandbox, expected);
  assert.deepEqual(calls, [
    { command: 'sudo', args: ['chown', 'root:root', sandbox], options: { stdio: 'inherit' } },
    { command: 'sudo', args: ['chmod', '4755', sandbox], options: { stdio: 'inherit' } },
  ]);
});

test('non-Linux use stops before loading Electron or changing permissions', () => {
  assert.throws(() => prepareElectronSandbox({ platform: 'darwin', loadElectron() { throw Error('must not load'); } }), /ci_electron_sandbox_linux_required/);
});

test('invalid executable paths and absent/nonregular helpers never invoke sudo', () => {
  const run = () => { throw Error('must not run'); };
  for (const executable of [undefined, {}, 'relative/electron']) assert.throws(() => prepareElectronSandbox({ platform: 'linux', loadElectron: () => executable, run }), /ci_electron_path_invalid/);
  for (const stat of [() => { throw Error('missing'); }, () => ({ isFile: () => false })]) {
    assert.throws(() => prepareElectronSandbox({ platform: 'linux', loadElectron: () => join(tmpdir(), 'electron'), stat, run }), /ci_electron_sandbox_missing/);
  }
});

test('permission failure remains fatal and cannot report a prepared sandbox', () => {
  let calls = 0;
  assert.throws(() => prepareElectronSandbox({ platform: 'linux', loadElectron: () => join(tmpdir(), 'electron'), stat: () => ({ isFile: () => true }),
    run() { calls++; throw Error('synthetic permission failure'); } }), /synthetic permission failure/);
  assert.equal(calls, 1);
});

test('workflow invokes the helper directly without capturing installer stdout', () => {
  const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ci-tests.yml', import.meta.url), 'utf8'));
  const step = workflow.jobs['unit-tests'].steps.find(value => value.name === 'Prepare sandboxed Electron on Linux');
  assert.equal(step.if, "runner.os == 'Linux'");
  assert.match(step.run, /^\s*node scripts\/ci\/prepare-electron-sandbox\.mjs$/m);
  assert.doesNotMatch(step.run, /sandbox_path=|\$\(/);
});
