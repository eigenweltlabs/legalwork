import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('benchmark controls cannot reach release publication without nonpublishing mode', () => {
  const alpha = workflow('alpha-macos-aarch64');
  assert.match(alpha.concurrency.group, /inputs.signing_test && format\('benchmark-/);
  const guard = alpha.jobs.changes.steps.find(step => step.name === 'Require benchmark inputs to be nonpublishing');
  for (const [profile, version, linux] of [['serial-full-ui', '', 'false'], ['optimized', '1.0.0-alpha.0.g1234567', 'false'], ['optimized', '', 'true']]) {
    const run = signing => spawnSync('bash', ['-e', '-c', guard.run], { env: { ...process.env,
      SIGNING_TEST: signing, PROFILE: profile, VERSION: version, LINUX_BENCHMARK: linux } });
    assert.notEqual(run('false').status, 0);
    assert.equal(run('true').status, 0);
  }
  for (const name of ['publish-alpha-macos-aarch64', 'publish-alpha-windows']) {
    const steps = alpha.jobs[name].steps;
    for (const step of steps.filter(step => step.run?.includes('gh release '))) assert.match(step.if, /!inputs.signing_test/);
    assert.ok(steps.some(step => step.name === 'Verify packaged startup'));
    assert.ok(steps.some(step => step.name === 'Retain redacted startup failure diagnostics' && step.if === 'failure()'));
  }
  const linux = alpha.jobs['linux-packaging-benchmark'];
  assert.match(linux.if, /inputs.signing_test && inputs.linux_benchmark/);
  const benchmark = workflow('ci-linux-packaging-benchmark');
  assert.equal(benchmark.permissions.contents, 'read');
  for (const step of benchmark.jobs.package.steps.filter(step => step.run?.includes('electron-builder'))) assert.match(step.run, /--publish never/);
});

test('Linux compression control stays confined to Linux and retains native startup checks', () => {
  const release = workflow('release-macos-aarch64');
  const step = release.jobs['publish-electron'].steps.find(step => step.name === 'Package Electron (Linux)');
  assert.equal(step.if, "matrix.os_type == 'linux'");
  assert.equal(step.env.ELECTRON_BUILDER_COMPRESSION_LEVEL, '6');
  for (const job of Object.values(release.jobs)) for (const other of job.steps ?? []) {
    if (other !== step) assert.equal(other.env?.ELECTRON_BUILDER_COMPRESSION_LEVEL, undefined);
  }
  const benchmark = workflow('ci-linux-packaging-benchmark').jobs.package;
  assert.deepEqual(benchmark.strategy.matrix.include.map(row => row.arch), ['x64', 'arm64']);
  assert.ok(benchmark.steps.some(step => step.run?.includes('packaged-startup-regression.mjs')));
  assert.ok(benchmark.steps.some(step => step.run?.includes('benchmark-linux-archive.mjs')));
});
