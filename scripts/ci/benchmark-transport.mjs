import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sandboxRuntimeTestFiles } from './sandbox-test-files.mjs';

const directory = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'legalwork-transport-profile');
mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'transport-profile.test.mjs');
const compiled = spawnSync('bun', ['build', 'scripts/ci/transport-profile-case.mjs', '--outfile', entry, '--target=node', '--format=esm', '--external=bun:test'], { stdio: 'inherit' });
if (compiled.status !== 0) throw new Error('Transport diagnostic compilation failed');
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const compiledSha256 = createHash('sha256').update(readFileSync(entry)).digest('hex');
const results = [];
const prepared = spawnSync(process.execPath, ['scripts/gen-core-skills.mjs', '--check'], { stdio: 'inherit' });
if (prepared.status !== 0) throw new Error('Transport fixture preparation failed');
for (const engine of ['bun', 'node', 'bun-source-file', 'bun-native-collection']) {
  const command = engine.startsWith('bun') ? 'bun' : path.resolve('apps/desktop/resources/node', process.platform === 'win32' ? 'node.exe' : 'node');
  const started = performance.now();
  const files = engine === 'bun-source-file' ? ['agent-sandbox/raw-http-node.test.ts'] : sandboxRuntimeTestFiles;
  const args = engine.startsWith('bun-')
    ? ['test', '--preload', './apps/server/test-preload.ts', '--test-name-pattern', '^real Node hop preserves', ...files.map(file => 'apps/server/src/' + file)]
    : [engine === 'bun' ? 'test' : '--test', entry];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 45000, env: { ...process.env, LEGALWORK_TEST_PREPARED: '1', LEGALWORK_SANDBOX_INTEGRATION: '1' } });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  results.push({ engine, version: spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout.trim(), durationMs: Math.round(performance.now() - started), status: result.status, signal: result.signal, error: result.error?.message,
    phases: (result.stdout ?? '').split('\n').map(line => line.replace(/^# /, '')).filter(line => line.startsWith('{"kind":"transport-profile"')).map(line => JSON.parse(line)) });
  writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify({ source, compiledSha256, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, cores: os.availableParallelism(), memoryBytes: os.totalmem(), results }, null, 2) + '\n');
}
process.exitCode = results.some(result => result.status !== 0) ? 1 : 0;
