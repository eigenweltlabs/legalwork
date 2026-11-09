// File workers own their globals, profile and environment. Tests inside a file
// stay serial: many fixtures intentionally change process.env and module mocks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import timing from './timing.cjs';
import { sandboxTransportTestFile, serverUnitIgnorePatterns } from './sandbox-test-files.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function testWorkers(value = process.env.LEGALWORK_TEST_WORKERS) {
  const workers = value === undefined ? Math.min(2, availableParallelism()) : Number(value);
  assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 8, 'Test workers must be an integer from 1 to 8');
  return workers;
}

export const serialServerTestFiles = ['wiki/file-access-policy.e2e.test.ts', 'wikis-team.e2e.test.ts'];

export function testArguments(suite, files = [], workers = suite === 'sandbox' ? 1 : testWorkers()) {
  assert.ok(['app', 'server', 'engine', 'sandbox'].includes(suite), 'Unknown test suite');
  if (suite === 'sandbox') {
    assert.equal(workers, 1, 'Native VM files must run serially');
    assert.ok(files.length > 0, 'Native sandbox tests require an explicit file list');
  }
  return ['test', ...(workers > 1 || suite === 'server' ? [`--parallel=${workers}`] : []),
    ...(suite === 'server' && files.length === 0 ? [...serverUnitIgnorePatterns, ...serialServerTestFiles.map(file => `**/${file}`)].map(pattern => `--path-ignore-patterns=${pattern}`) : []),
    ...(suite === 'app' ? [] : ['--preload', path.join(root, 'apps/server/test-preload.ts')]),
    ...(['engine', 'sandbox'].includes(suite) ? ['--timeout', '180000'] : []),
    ...(files.length ? files : [suite === 'app' ? 'tests/' : 'src/'])];
}

const isSerialServerTest = file => serialServerTestFiles.some(name => file.replaceAll('\\', '/').endsWith('/' + name));

export function testGroups(suite, files) {
  if (suite === 'server' && files.length === 0) return [[], serialServerTestFiles.map(file => path.join(root, 'apps/server/src', file))];
  if (suite === 'server') {
    const serial = files.filter(isSerialServerTest);
    const parallel = files.filter(file => !isSerialServerTest(file));
    return [parallel, serial].filter(group => group.length);
  }
  if (suite !== 'sandbox') return [files];
  const isTransport = file => file.replaceAll('\\', '/').endsWith('/' + sandboxTransportTestFile);
  const transport = files.filter(isTransport), remaining = files.filter(file => !isTransport(file));
  // Large IPC buffers do not share a Bun heap/module context with VM fixtures.
  // Both processes remain serial; every selected file still executes once.
  return transport.length && remaining.length ? [transport, remaining] : [files];
}

export function runTests(suite, files = []) {
  const prepared = spawnSync(process.execPath, [path.join(root, 'scripts/gen-core-skills.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  if (prepared.status !== 0) return prepared.status ?? 1;
  const workers = suite === 'sandbox' ? 1 : testWorkers(), started = performance.now();
  const groups = testGroups(suite, files), serialStartup = suite === 'server' && files.length === 0;
  if (serialStartup) for (const file of groups[1]) assert.ok(lstatSync(file).isFile(), `Missing startup fixture: ${file}`);
  let status = 0;
  for (const group of groups) {
    const groupWorkers = suite === 'server' && group.some(isSerialServerTest) ? 1 : workers;
    const result = spawnSync(process.env.LEGALWORK_TEST_BUN_BIN || 'bun', testArguments(suite, group, groupWorkers), {
      cwd: ['engine', 'sandbox'].includes(suite) ? root : path.join(root, 'apps', suite === 'app' ? 'app' : 'server'),
      env: { ...process.env, LEGALWORK_TEST_PREPARED: '1' }, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    status ||= result.status ?? 1;
  }
  timing.recordSpan(`tests:${suite}`, started, { workers, groups: groups.length, status });
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runTests(process.argv[2], process.argv.slice(3));
}
