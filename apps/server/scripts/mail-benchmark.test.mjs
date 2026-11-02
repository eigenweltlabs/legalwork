import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('measurement and export commands refuse existing evidence before compiling or starting a worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-benchmark-output-'));
  try {
    const report = join(directory, 'baseline.json'), destination = join(directory, 'checkpoint');
    await writeFile(report, 'preserved measurement'); await mkdir(destination);
    const marker = join(destination, 'marker'); await writeFile(marker, 'preserved checkpoint');
    for (const args of [['100', report], ['--retained', join(directory, 'unused'), report],
      ['--export', join(directory, 'unused'), destination], ['--checkpoint', join(directory, 'unused'), destination]]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./mail-benchmark.mjs', import.meta.url)), ...args], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.match(result.stderr, /Benchmark output must not already exist/);
      assert.equal(result.stdout, '');
    }
    const next = join(directory, 'new-report.json'), runner = fileURLToPath(new URL('./mail-benchmark.mjs', import.meta.url));
    for (const [settings, expected] of [
      [{ LEGALWORK_MAIL_BENCH_BUDGET_MS: '1000', LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: destination }, /must not already exist/],
      [{ LEGALWORK_MAIL_BENCH_BUDGET_MS: '1000', LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: next }, /must differ/],
      [{ LEGALWORK_MAIL_BENCH_BUDGET_MS: '0', LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: next }, /Invalid benchmark budget/],
    ]) {
      const result = spawnSync(process.execPath, [runner, '100', next], { env: { ...process.env, ...settings }, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.match(result.stderr, expected); assert.equal(result.stdout, '');
    }
    assert.equal(await readFile(report, 'utf8'), 'preserved measurement');
    assert.equal(await readFile(marker, 'utf8'), 'preserved checkpoint');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
