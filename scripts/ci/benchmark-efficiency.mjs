// A single before/after pass. Dependency installation, generated prerequisites
// and optional native engine preparation happen before these measurements.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
for (const name of ['--baseline', '--bun', '--output']) assert.ok(args.includes(name), `Missing ${name}`);
const baseline = realpathSync(value('--baseline')), bun = realpathSync(value('--bun')), output = path.resolve(value('--output'));
mkdirSync(output, { recursive: true });
// First execution of a freshly downloaded native binary can be slower.
// Prepare both pinned Node workers before any timed test fixture.
for (const checkout of [baseline, root]) {
  const worker = path.join(checkout, 'apps/desktop/resources/node', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(spawnSync(worker, ['--version'], { encoding: 'utf8' }).status, 0, `Prepare the pinned Node worker in ${checkout}`);
}
const baseEnvironment = { ...process.env, TZ: 'Europe/Berlin', LEGALWORK_TEST_OPENCODE_BIN: '', LEGALWORK_TEST_OPENCODE_CACHE: '' };
const cases = [];
for (const suite of ['app', 'server']) {
  cases.push({ name: `${suite}-baseline`, cwd: path.join(baseline, 'apps', suite), command: [bun, 'test', suite === 'app' ? 'tests/' : 'src/'], env: baseEnvironment });
  for (const workers of [2, 4]) cases.push({ name: `${suite}-candidate-${workers}`, cwd: root, command: [process.execPath, 'scripts/ci/run-tests.mjs', suite], env: { ...baseEnvironment, LEGALWORK_TEST_BUN_BIN: bun, LEGALWORK_TEST_WORKERS: String(workers) } });
}
if (process.env.LEGALWORK_BENCHMARK_ENGINE) {
  const binary = realpathSync(process.env.LEGALWORK_BENCHMARK_ENGINE);
  const env = { ...baseEnvironment, LEGALWORK_TEST_OPENCODE_BIN: binary, LEGALWORK_TEST_OPENCODE_CACHE: process.env.LEGALWORK_BENCHMARK_ENGINE_CACHE || '' };
  // The old coordinator hardcodes a bare `bun`. Retain its file discovery and
  // arguments while selecting the same explicit executable as every case.
  const { engineTestFiles } = await import(pathToFileURL(path.join(baseline, 'scripts/ci/run-engine-tests.mjs')).href);
  const files = engineTestFiles(path.join(baseline, 'apps/server/src'));
  assert.ok(files.length > 0, 'No declared baseline engine tests found');
  cases.push({ name: 'engine-baseline', cwd: baseline, command: [bun, 'test', '--preload', './apps/server/test-preload.ts', '--timeout', '180000', ...files], env });
  for (const workers of [2, 4]) cases.push({ name: `engine-candidate-${workers}`, cwd: root, command: [process.execPath, 'scripts/ci/run-engine-tests.mjs'], env: { ...env, LEGALWORK_TEST_BUN_BIN: bun, LEGALWORK_TEST_WORKERS: String(workers) } });
}
const portable = ['calendar-format', 'task-format', 'benchmark-format', 'storage-display-path'];
const temporary = [];
if (args.includes('--vitest-bin')) {
  const vitest = value('--vitest-bin'), vitestModule = path.resolve(path.dirname(vitest), '../vitest/dist/index.js');
  cases.push({ name: 'portable-bun', cwd: path.join(root, 'apps/app'), command: [bun, 'test', ...portable.map(name => `tests/${name}.test.ts`)], env: baseEnvironment });
  for (const name of portable) {
    const source = path.join(root, `apps/app/tests/${name}.test.ts`), target = path.join(root, `apps/app/tests/.ci-benchmark-${name}.vitest.ts`);
    writeFileSync(target, readFileSync(source, 'utf8').replaceAll('"bun:test"', '"vitest"')); temporary.push(target);
  }
  const config = path.join(output, 'vitest.config.mjs');
  writeFileSync(config, `export default ${JSON.stringify({ resolve: { alias: { vitest: vitestModule, '@': path.join(root, 'apps/app/src') } }, test: { include: ['apps/app/tests/.ci-benchmark-*.vitest.ts'], maxWorkers: 1, fileParallelism: false } })};\n`);
  cases.push({ name: 'portable-vitest', cwd: root, command: [vitest, 'run', '--config', config, '--reporter=json', '--outputFile', path.join(output, 'vitest-results.json')], env: baseEnvironment });
}
const results = [];
try {
  for (const entry of cases) {
    const request = path.join(output, `${entry.name}-request.json`), result = path.join(output, `${entry.name}.json`), log = path.join(output, `${entry.name}.log`);
    // The request contains inherited environment values. Keep it private and
    // remove it immediately; only measurements and synthetic test logs remain.
    writeFileSync(request, JSON.stringify({ ...entry, result, log }), { mode: 0o600 });
    console.log(`Benchmark: ${entry.name}`);
    try { spawnSync('python3', [path.join(root, 'scripts/ci/measure-command.py'), request], { stdio: 'inherit' }); }
    finally { rmSync(request); }
    const measured = JSON.parse(readFileSync(result, 'utf8')), text = readFileSync(log, 'utf8');
    const count = kind => Number([...text.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`, 'g'))].at(-1)?.[1] ?? 0);
    const row = { name: entry.name, ...measured, passed: count('pass'), failed: count('fail'), skipped: count('skip') };
    if (entry.name === 'portable-vitest' && measured.exitCode === 0) {
      const report = JSON.parse(readFileSync(path.join(output, 'vitest-results.json'), 'utf8'));
      row.passed = report.numPassedTests; row.failed = report.numFailedTests; row.skipped = report.numPendingTests;
    }
    results.push(row); console.log(JSON.stringify(row));
  }
} finally { for (const filename of temporary) rmSync(filename, { force: true }); }
const report = { measuredAt: new Date().toISOString(), passesPerCase: 1, platform: `${process.platform}-${process.arch}`, node: process.version, bun,
  bunVersion: spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  baselineCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).stdout.trim(),
  candidateCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), results };
writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
process.exitCode = results.some(row => row.exitCode !== 0 || row.failed !== 0) ? 1 : 0;
