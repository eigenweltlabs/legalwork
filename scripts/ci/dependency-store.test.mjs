import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dependencyStore } from './dependency-store.mjs';
import { changeScope } from './change-scope.mjs';

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const action = parse(readFileSync(new URL('../../.github/actions/install-dependencies/action.yml', import.meta.url), 'utf8'));
const config = { filter: 'legalwork-server...', temporary: '/job temp', os: 'Linux', arch: 'ARM64', nodeAbi: '137' };

test('packaging filters include the server and desktop workspace dependencies without the renderer build graph', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/alpha-windows-x64.yml', import.meta.url), 'utf8'));
  const filters = Object.values(workflow.jobs).flatMap(job => job.steps ?? []).find(step => step.name === 'Install dependencies').with.filter.trim().split('\n');
  const selected = JSON.parse(execFileSync('pnpm', [...filters.flatMap(selector => ['--filter', selector]),
    'list', '--depth', '-1', '--json'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' })).map(item => item.name);
  for (const name of ['@legalwork/desktop', 'legalwork-server', 'legalwork-orchestrator', '@legalwork/actaport-mcp', '@legalwork/types', '@legalwork/opencode-release', '@legalwork/openui']) {
    assert.ok(selected.includes(name), 'Missing workspace dependency: ' + name);
  }
  assert.ok(!selected.includes('@legalwork/app'), 'Shared renderer artifacts do not require rebuilding its dependency graph');
});

test('filtered stores cannot restore or populate a full workspace cache', () => {
  const scoped = dependencyStore(config);
  const full = dependencyStore({ ...config, filter: '', defaultStore: '/full store/v10' });
  assert.notEqual(scoped.path, full.path);
  assert.notEqual(scoped.prefix, full.prefix);
  assert.equal(scoped.restoreKeys, scoped.prefix);
  assert.ok(!scoped.restoreKeys.includes('electron-pnpm'));
  assert.ok(full.restoreKeys.includes('Linux-ARM64-electron-pnpm-'));
  assert.equal(full.prefix, 'pnpm-v1-Linux-ARM64-');
  for (const changed of [{ filter: '@legalwork/app...' }, { ignoreScripts: 'true' }, { nodeAbi: '138' }, { os: 'Windows' }, { arch: 'X64' }]) {
    assert.notEqual(scoped.prefix, dependencyStore({ ...config, ...changed }).prefix);
  }
  const windows = dependencyStore({ ...config, os: 'Windows', temporary: 'D:\\runner temp' });
  assert.ok(windows.path.startsWith('D:\\runner temp\\pnpm-filtered-'));
  assert.throws(() => dependencyStore({ ...config, filter: '' }), /default pnpm store/);
});

test('filtered cache saves are enabled, and installation uses the exact cached path with native scripts retained', () => {
  const restore = action.runs.steps.find(step => step.uses === 'actions/cache/restore@v4');
  const save = action.runs.steps.find(step => step.uses === 'actions/cache/save@v4');
  assert.equal(restore.if, "inputs.cache == 'true'");
  assert.equal(action.inputs['save-cache'].default, 'true');
  assert.equal(save.if, "inputs.cache == 'true' && inputs.save-cache == 'true' && steps.cache.outputs.cache-hit != 'true'");
  const gate = parse(readFileSync(new URL('../../.github/workflows/ci-tests.yml', import.meta.url), 'utf8'));
  const electronInstall = gate.jobs['electron-ui'].steps.find(step => step.uses === './.github/actions/install-dependencies');
  assert.deepEqual(electronInstall.with, { 'save-cache': 'false' });
  assert.equal(save.with.path, restore.with.path);
  assert.equal(restore.with['restore-keys'], '${{ steps.store.outputs.restore-keys }}');
  const directory = mkdtempSync(path.join(tmpdir(), 'filtered-store-arguments-'));
  try {
    const bin = path.join(directory, 'bin');mkdirSync(bin);
    writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nnode -e \'require("node:fs").writeFileSync(process.env.INSTALL_TRACE,JSON.stringify(process.argv.slice(1)))\' -- "$@"\n', { mode: 0o755 });
    const install = action.runs.steps.find(step => step.name === 'Install dependencies');
    for (const ignoreScripts of ['false', 'true']) for (const filter of [config.filter, '@legalwork/desktop...\nlegalwork-server...\n', '']) {
      const trace = path.join(directory, 'arguments');
      execFileSync('bash', ['-eu', '-c', install.run], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        INSTALL_TRACE: trace, PNPM_STORE_DIR: path.join(directory, 'scoped store'), WORKSPACE_FILTER: filter, IGNORE_SCRIPTS: ignoreScripts } });
      const args = JSON.parse(readFileSync(trace, 'utf8'));
      assert.deepEqual(args, [...(filter ? ['--store-dir', path.join(directory, 'scoped store'), ...filter.split('\n').filter(Boolean).flatMap(selector => ['--filter', selector])] : []), 'install', '--frozen-lockfile', '--prefer-offline', ...(ignoreScripts === 'true' ? ['--ignore-scripts'] : [])]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const scope = changeScope(['scripts/ci/dependency-store.mjs']);
  for (const name of ['units', 'engine', 'server', 'sandbox']) assert.equal(scope[name], true, name);
});
