import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { engineTestFiles } from './run-engine-tests.mjs';
import { sourceBuildIdentity } from '../../packages/opencode-release/build/prepare.mjs';
import recipe from '../../packages/opencode-release/build/recipe.json' with { type: 'json' };

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('shared cache producer covers current fingerprint inputs but ignores ordinary app changes', async () => {
  const producer = workflow('ci-opencode-cache');
  assert.deepEqual(producer.on.push.branches, ['dev']);
  assert.deepEqual(Object.keys(producer.on).sort(), ['push', 'workflow_dispatch']);
  assert.equal(producer.concurrency['cancel-in-progress'], false);
  assert.equal(producer.jobs['warm-cache'].if, "github.ref == 'refs/heads/dev'");
  assert.equal(producer.jobs['warm-cache'].uses, './.github/workflows/ci-opencode-derivative.yml');
  assert.deepEqual(producer.jobs['warm-cache'].with, { 'build-mode': 'development', ref: '${{ github.sha }}' });
  assert.equal(producer.jobs['warm-cache'].secrets, undefined);
  const paths = producer.on.push.paths;
  const matches = name => paths.some(pattern => path.matchesGlob(name, pattern));
  const identity = await sourceBuildIdentity({ mode: 'development', targets: recipe.targets });
  const inputs = [...Object.keys(identity.files).map(name => `packages/opencode-release/${name}`),
    recipe.inputs.patch.path, recipe.inputs.testReceipt.path,
    'scripts/ci/cache-opencode-derivative.mjs', 'scripts/ci/build-opencode-derivative.mjs'];
  for (const name of inputs) assert.equal(matches(name), true, `Missing cache warm-up trigger: ${name}`);
  for (const name of ['apps/server/src/connectors/mail.ts', 'apps/app/src/components/ui/button.tsx', 'docs/user-guide/email.md']) assert.equal(matches(name), false, name);
});

test('normal PR reuse still verifies cache bytes and production still rejects development cache reuse', () => {
  const build = workflow('ci-opencode-derivative').jobs.build;
  const restore = build.steps.findIndex(step => step.uses === 'actions/cache/restore@v4');
  const verify = build.steps.findIndex(step => step.name === 'Verify all development archives against current source policy');
  const save = build.steps.findIndex(step => step.uses === 'actions/cache/save@v4');
  const upload = build.steps.findIndex(step => step.with?.name === 'opencode-derivative-ci' && step.uses === 'actions/upload-artifact@v4');
  assert.ok(restore >= 0 && restore < verify && verify < save && save < upload);
  assert.match(build.steps[restore].if, /inputs.build-mode == 'development'/);
  assert.equal(build.steps[restore].with['restore-keys'], undefined);
  assert.match(build.steps[verify].run, /cache-opencode-derivative.mjs verify/);
  assert.match(build.steps.find(step => step.name === 'Validate explicit producer reuse inputs').run, /Production must compile and sign/);
});

test('engine discovery includes nested and newly added fixtures, excluding ordinary code and symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-engine-fixtures-'));
  try {
    mkdirSync(path.join(root, 'nested'));
    const first = path.join(root, 'first.released.test.ts'), later = path.join(root, 'nested/later.test.ts');
    writeFileSync(first, "const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;");
    writeFileSync(path.join(root, 'normal.test.ts'), 'test("fixture", () => {});');
    writeFileSync(path.join(root, 'runtime.ts'), 'process.env.LEGALWORK_TEST_OPENCODE_BIN');
    symlinkSync(first, path.join(root, 'linked.test.ts'));
    assert.deepEqual(engineTestFiles(root), [first]);
    writeFileSync(later, 'const binary = Bun.env.LEGALWORK_TEST_OPENCODE_BIN;');
    assert.deepEqual(engineTestFiles(root), [first, later].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real engine job cannot pass by silently skipping all engine fixtures', () => {
  const script = fileURLToPath(new URL('./run-engine-tests.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script], { env: { ...process.env, LEGALWORK_TEST_OPENCODE_BIN: '' }, stdio: 'pipe' }), /Set up the verified engine/);
  const integration = workflow('ci-tests').jobs['engine-tests'];
  assert.match(integration.if, /needs.changes.outputs.engine == 'true'/);
  const serverTests = integration.steps.find(step => step.name === 'Run server engine integration tests');
  assert.equal(serverTests.if, "needs.changes.outputs.server == 'true'");
  assert.match(serverTests.run, /run-engine-tests.mjs/);
  const files = engineTestFiles(fileURLToPath(new URL('../../apps/server/src', import.meta.url)));
  for (const file of ['managed-opencode.released.test.ts', 'agent-sandbox/engine.integration.test.ts']) {
    assert.ok(!files.some(filename => filename.endsWith('/' + file)));
    assert.ok(integration.steps.some(step => step.run?.includes(file)), `Missing dedicated engine execution: ${file}`);
  }
  assert.ok(files.some(filename => filename.endsWith('/opencode-plugins/legalwork-skill-resources.integration.test.ts')));
  for (const suffix of ['scheduled-tasks/engine.test.ts', 'managed-opencode.search.e2e.test.ts', 'opencode-plugins/pdf-reading.integration.test.ts']) assert.ok(files.some(filename => filename.endsWith(suffix)), suffix);
});

test('existing required check names fail if units or a selected engine build fail', () => {
  const gate = workflow('ci-tests').jobs['legalwork-tests'];
  assert.deepEqual(gate.strategy.matrix.os, ['ubuntu-latest', 'macos-14']);
  assert.equal(gate.name, 'legalwork-tests (${{ matrix.os }})');
  assert.equal(gate['runs-on'], 'ubuntu-latest');
  for (const name of ['unit-tests', 'engine-tests']) {
    assert.equal(workflow('ci-tests').jobs[name]['runs-on'], "${{ matrix.os == 'macos-14' && 'macos-15' || matrix.os }}");
  }
  assert.ok(gate.needs.includes('unit-tests'));
  assert.ok(gate.needs.includes('engine-tests'));
  assert.ok(gate.needs.includes('sandbox-runtime'));
  const script = gate.steps[0].run;
  const run = results => execFileSync('bash', ['-e', '-c', script], {
    env: { ...process.env, RESULTS: JSON.stringify(results) }, stdio: 'pipe',
  });
  assert.doesNotThrow(() => run({ units: { result: 'success' }, engine: { result: 'skipped' } }));
  for (const result of ['failure', 'cancelled']) {
    assert.throws(() => run({ units: { result }, engine: { result: 'success' } }));
    assert.throws(() => run({ units: { result: 'success' }, sandbox: { result } }));
  }
});


test('runtime cache hits retain verification and isolation tests while skipping full workspace preparation', () => {
  const jobs = workflow('sandbox-runtime').jobs;
  for (const job of Object.values(jobs).filter(job => job.steps?.some(step => step.uses === 'actions/cache/restore@v4'))) {
    const restore = job.steps.find(step => step.uses === 'actions/cache/restore@v4');
    assert.equal(restore.with['restore-keys'], undefined);
    const verify = job.steps.find(step => step.run?.includes('cache-sandbox-runtime.mjs verify'));
    assert.ok(verify, 'Every restored bundle must be verified');
    for (const step of job.steps.filter(step => step.uses === './.github/actions/install-dependencies')) assert.match(step.if, /inputs.run_tests/);
    for (const step of job.steps.filter(step => step.uses === 'actions/cache/save@v4')) assert.equal(step.if, "steps.runtime-cache.outputs.cache-hit != 'true'");
  }
  assert.equal(workflow('ci-runtime-cache').jobs.warm.with.run_tests, false);
  assert.equal(workflow('ci-runtime-cache').jobs.warm.with.publish_runtime, false);
  assert.ok(workflow('ci-runtime-cache').on.schedule.length);
  const guest = jobs.guest.steps.find(step => step.with?.name === 'sandbox-guest-${{ matrix.arch }}');
  assert.equal(guest.with.path, 'apps/server/resources/agent-sandbox/runtime/*');
  assert.equal(guest.with['include-hidden-files'], false);
  const artifact = jobs.runtime.steps.find(step => step.with?.name === 'sandbox-runtime-${{ matrix.platform }}-${{ matrix.arch }}');
  assert.equal(artifact.if, 'inputs.publish_runtime');
});

test('every native package consumer uses one portable producer and an OS-family engine handoff', () => {
  for (const name of ['alpha-macos-aarch64', 'alpha-windows-x64', 'release-macos-aarch64', 'ci-desktop-packaging']) {
    const jobs = workflow(name).jobs;
    assert.equal(jobs['portable-assets'].uses, './.github/workflows/ci-portable-assets.yml');
    const consumers = Object.values(jobs).filter(job => job.steps?.some(step => step.env?.LEGALWORK_PREBUILT_UI === '1'));
    assert.ok(consumers.length, name);
    for (const job of consumers) {
      assert.ok(job.needs.includes('portable-assets'), name);
      assert.ok(job.steps.some(step => step.uses === 'actions/download-artifact@v4' && step.with.name === 'portable-desktop-assets'));
      const engine = job.steps.find(step => step.uses === './.github/actions/setup-opencode');
      assert.equal(engine.with['archive-family'], name === 'ci-desktop-packaging' ? "${{ inputs.derivative-manifest-sha256 != '' }}" : 'true');
      assert.ok(job.steps.some(step => step.with?.name === 'opencode-derivative-ci-${{ runner.os }}'));
    }
  }
  const build = workflow('ci-portable-assets').jobs.build;
  assert.equal(build.env.LEGALWORK_ELECTRON_BUILD, '1');
  assert.ok(build.steps.some(step => step.run?.includes('portable-assets.mjs seal')));
});
