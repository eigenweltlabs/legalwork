import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxRuntimeTestFiles } from './sandbox-test-files.mjs';
import { serialServerTestFiles, testArguments, testGroups, testWorkers } from './run-tests.mjs';

test('worker configuration is bounded and keeps tests inside a file serial', () => {
  for (const value of ['0', '-1', '2.5', '9', 'bad', '']) assert.throws(() => testWorkers(value));
  assert.equal(testWorkers('2'), 2);
  assert.ok(testArguments('app', [], 2).includes('--parallel=2'));
  assert.ok(!testArguments('app', [], 1).some(arg => arg.startsWith('--parallel')));
  assert.ok(!testArguments('server', [], 2).includes('--concurrent'));
  assert.ok(!testArguments('server', [], 2).includes('--no-isolate'));
});

test('real-engine selection cannot fall back to unit discovery', () => {
  const files = ['/fixture/real.test.ts'];
  const args = testArguments('engine', files, 2);
  assert.equal(args.at(-1), files[0]);
  assert.ok(args.includes('180000'));
  assert.ok(args.some(arg => arg.endsWith('apps/server/test-preload.ts')));
  assert.throws(() => testArguments('unknown'));
});


test('native IPC file isolation preserves every native file once and every process stays serial', () => {
  const files = sandboxRuntimeTestFiles.map(file => '/fixture/src/' + file);
  const groups = testGroups('sandbox', files);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], ['/fixture/src/agent-sandbox/raw-http-node.test.ts']);
  assert.equal(groups[1].length, 10);
  assert.deepEqual(groups.flat().sort(), [...files].sort());
  for (const group of groups) {
    const args = testArguments('sandbox', group);
    assert.ok(!args.some(arg => arg.startsWith('--parallel')));
    assert.ok(args.includes('180000'));
  }
  assert.deepEqual(testGroups('engine', files), [files]);
  assert.deepEqual(testGroups('sandbox', [files[0]]), [[files[0]]]);
});

test('a failed isolated transport file cannot skip the remaining native checks or turn the suite green', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-test-coordinator-'));
  const executable = path.join(directory, 'fake-bun'), calls = path.join(directory, 'calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');process.exit(args.some(arg=>arg.endsWith('raw-http-node.test.ts'))?3:0);
`, { mode: 0o755 });
  try {
    const files = ['/fixture/src/agent-sandbox/host.test.ts', '/fixture/src/agent-sandbox/raw-http-node.test.ts'];
    const exercise = path.join(directory, 'exercise.mjs');
    writeFileSync(exercise, `import { runTests } from ${JSON.stringify(new URL('./run-tests.mjs', import.meta.url).href)};process.exitCode=runTests('sandbox',${JSON.stringify(files)});`);
    // The expected failure and its timing stay inside this contract fixture.
    const result = spawnSync(process.execPath, [exercise], { encoding: 'utf8', env: { ...process.env,
      LEGALWORK_TEST_BUN_BIN: executable, LEGALWORK_CI_TIMINGS: path.join(directory, 'timings.jsonl') } });
    assert.equal(result.status, 3, result.stderr);
    const executed = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(executed.length, 2);
    assert.equal(executed[0].at(-1), files[1]);
    assert.equal(executed[1].at(-1), files[0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('startup API fixtures get a fresh isolated worker without changing deadlines or dropping discovery coverage', () => {
  const groups = testGroups('server', []);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], []);
  assert.deepEqual(groups[1].map(file => file.replaceAll('\\', '/').split('/src/')[1]), serialServerTestFiles);
  const regular = testArguments('server', [], 2), startup = testArguments('server', groups[1], 1);
  for (const file of serialServerTestFiles) assert.ok(regular.includes('--path-ignore-patterns=**/' + file));
  assert.ok(regular.includes('--parallel=2'));
  assert.ok(startup.includes('--parallel=1')); // One worker still implies Bun file isolation.
  assert.ok(!startup.some(arg => arg.startsWith('--path-ignore-patterns')));
  assert.ok(!startup.includes('--timeout')); // Retain the original five-second Bun default.
  assert.deepEqual(testGroups('server', groups[1]), [groups[1]]);
  const ordinary = '/workspace/apps/server/src/workspace.e2e.test.ts';
  assert.deepEqual(testGroups('server', [...groups[1], ordinary]), [[ordinary], groups[1]]);
});
