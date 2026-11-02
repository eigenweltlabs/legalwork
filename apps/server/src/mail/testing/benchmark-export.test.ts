import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('benchmark checkpoints use actual encrypted Node storage and reject incomplete certification', () => {
  const node = Bun.which('node');
  if (!node) throw Error('Actual Node is required');
  const runner = fileURLToPath(new URL('../../../scripts/mail-acceptance.mjs', import.meta.url));
  const result = spawnSync(node, [runner, '--suite', 'testing/benchmark-export'], { encoding: 'utf8', timeout: 120000 });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw Error(result.stdout + '\n' + result.stderr);
  expect(result.status).toBe(0);
}, 125000);

test('benchmark CLI preserves existing reports and checkpoint directories', () => {
  const node = Bun.which('node');
  if (!node) throw Error('Actual Node is required');
  const suite = fileURLToPath(new URL('../../../scripts/mail-benchmark.test.mjs', import.meta.url));
  const result = spawnSync(node, ['--test', suite], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw Error(result.stdout + '\n' + result.stderr);
  expect(result.status).toBe(0);
}, 20000);
