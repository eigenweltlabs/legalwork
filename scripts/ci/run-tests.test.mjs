import assert from 'node:assert/strict';
import test from 'node:test';
import { testArguments, testWorkers } from './run-tests.mjs';

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
