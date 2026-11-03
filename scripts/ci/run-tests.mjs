// File workers own their globals, profile and environment. Tests inside a file
// stay serial: many fixtures intentionally change process.env and module mocks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import timing from './timing.cjs';
import { serverUnitIgnorePatterns } from './sandbox-test-files.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function testWorkers(value = process.env.LEGALWORK_TEST_WORKERS) {
  const workers = value === undefined ? Math.min(2, availableParallelism()) : Number(value);
  assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 8, 'Test workers must be an integer from 1 to 8');
  return workers;
}

export function testArguments(suite, files = [], workers = suite === 'sandbox' ? 1 : testWorkers()) {
  assert.ok(['app', 'server', 'engine', 'sandbox'].includes(suite), 'Unknown test suite');
  if (suite === 'sandbox') {
    assert.equal(workers, 1, 'Native VM files must run serially');
    assert.ok(files.length > 0, 'Native sandbox tests require an explicit file list');
  }
  return ['test', ...(workers > 1 ? [`--parallel=${workers}`] : []),
    ...(suite === 'server' && files.length === 0 ? serverUnitIgnorePatterns.map(pattern => `--path-ignore-patterns=${pattern}`) : []),
    ...(suite === 'app' ? [] : ['--preload', path.join(root, 'apps/server/test-preload.ts')]),
    ...(['engine', 'sandbox'].includes(suite) ? ['--timeout', '180000'] : []),
    ...(files.length ? files : [suite === 'app' ? 'tests/' : 'src/'])];
}

export function runTests(suite, files = []) {
  const prepared = spawnSync(process.execPath, [path.join(root, 'scripts/gen-core-skills.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  if (prepared.status !== 0) return prepared.status ?? 1;
  const workers = suite === 'sandbox' ? 1 : testWorkers(), started = performance.now();
  const result = spawnSync(process.env.LEGALWORK_TEST_BUN_BIN || 'bun', testArguments(suite, files, workers), {
    cwd: ['engine', 'sandbox'].includes(suite) ? root : path.join(root, 'apps', suite === 'app' ? 'app' : 'server'),
    env: { ...process.env, LEGALWORK_TEST_PREPARED: '1' }, stdio: 'inherit', windowsHide: true,
  });
  timing.recordSpan(`tests:${suite}`, started, { workers, status: result.status });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runTests(process.argv[2], process.argv.slice(3));
}
