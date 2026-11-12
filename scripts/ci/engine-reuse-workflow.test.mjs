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
  assert.equal(producer.jobs['warm-cache'].if, "github.ref == 'refs/heads/dev'");
  assert.equal(producer.jobs['warm-cache'].uses, './.github/workflows/ci-opencode-derivative.yml');
  assert.equal(producer.jobs['warm-cache'].with['build-mode'], 'development');
  assert.equal(producer.jobs['warm-cache'].secrets, undefined);
  const paths = producer.on.push.paths;
  const matches = name => paths.some(pattern => path.matchesGlob(name, pattern));
  const identity = await sourceBuildIdentity({ mode: 'development', targets: recipe.targets });
  const inputs = [...Object.keys(identity.files).map(name => `packages/opencode-release/${name}`),
    recipe.inputs.patch.path, recipe.inputs.testReceipt.path,
    'scripts/ci/build-opencode-derivative.mjs'];
  for (const name of inputs) assert.equal(matches(name), true, `Missing cache warm-up trigger: ${name}`);
  for (const name of ['apps/server/src/connectors/mail.ts', 'apps/app/src/components/ui/button.tsx', 'docs/user-guide/email.md']) assert.equal(matches(name), false, name);
});

test('normal PR reuse still verifies cache bytes and production still rejects development cache reuse', () => {
  const build = workflow('ci-opencode-derivative').jobs.build;
  const restore = build.steps.findIndex(step => step.uses === 'actions/cache/restore@v4');
  const verify = build.steps.findIndex(step => step.run?.includes('cache-opencode-derivative.mjs verify'));
  const save = build.steps.findIndex(step => step.uses === 'actions/cache/save@v4');
  const upload = build.steps.findIndex(step => step.with?.name === 'opencode-derivative-ci' && step.uses === 'actions/upload-artifact@v4');
  assert.ok(restore >= 0 && restore < verify && verify < save && save < upload);
  assert.match(build.steps[restore].if, /inputs.build-mode == 'development'/);
  assert.equal(build.steps[restore].with['restore-keys'], undefined);
  const base = build.steps.findIndex(step => step.id === 'base-producer');
  const download = build.steps.findIndex(step => step.with?.['run-id'] === '${{ steps.base-producer.outputs.run-id }}');
  assert.ok(restore < base && base < download && download < verify);
  assert.match(build.steps[base].if, /inputs.build-mode == 'development'/);
  assert.equal(build.steps[base].env.BASE_SHA, '${{ github.event.merge_group.base_sha || github.event.pull_request.base.sha }}');
  assert.match(build.steps.find(step => step.id === 'engine').if, /steps.base-producer.outputs.run-id == ''/);
  assert.match(build.steps.find(step => step.name === 'Validate explicit producer reuse inputs').run, /Production cannot use manually supplied development candidate reuse/);
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
  const integration = workflow('ci-engine-tests').jobs.tests;
  for (const name of ['engine-tests-linux', 'engine-tests-mac']) assert.match(workflow('ci-tests').jobs[name].if, /needs.changes.outputs.engine == 'true'/);
  const serverTests = integration.steps.find(step => step.name === 'Run server engine integration tests');
  assert.equal(integration.steps.find(step => step.name === 'Run affected native engine fixtures').env.LEGALWORK_TEST_WORKERS,
    '${{ inputs.engine-workers }}');
  assert.equal(serverTests.if, 'inputs.server');
  assert.match(serverTests.run, /run-engine-tests.mjs/);
  const files = engineTestFiles(fileURLToPath(new URL('../../apps/server/src', import.meta.url)));
  for (const file of ['managed-opencode.released.test.ts', 'agent-sandbox/engine.integration.test.ts']) {
    assert.ok(!files.some(filename => filename.endsWith('/' + file)));
    assert.ok(integration.steps.some(step => step.run?.includes(file)), `Missing dedicated engine execution: ${file}`);
  }
  assert.ok(files.some(filename => filename.endsWith('/opencode-plugins/legalwork-skill-resources.integration.test.ts')));
  for (const suffix of ['scheduled-tasks/engine.test.ts', 'managed-opencode.search.e2e.test.ts', 'opencode-plugins/pdf-reading.integration.test.ts']) assert.ok(files.some(filename => filename.endsWith(suffix)), suffix);
  const planner = workflow('ci-tests').jobs.changes.steps;
  const prepare = planner.findIndex(step => step.name === 'Prepare the shared dependency analyzer');
  assert.ok(planner.findIndex(step => step.id === 'scope') < prepare && prepare < planner.findIndex(step => step.id === 'plan'));
  assert.equal(planner[prepare].if, "steps.scope.outputs.server == 'true'");
  assert.deepEqual(planner[prepare].with, { 'ignore-scripts': 'true', filter: 'legalwork-server...' });
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
  assert.equal(workflow('ci-runtime-cache').jobs.warm.with.retain_fresh_build, true);
  assert.ok(workflow('ci-runtime-cache').on.schedule.length);
  const guest = jobs.guest.steps.find(step => step.with?.name === 'sandbox-guest-${{ matrix.arch }}');
  assert.equal(guest.with.path, 'apps/server/resources/agent-sandbox/runtime/*');
  assert.equal(guest.with['include-hidden-files'], false);
  const prepare = parse(readFileSync(new URL('../../.github/actions/prepare-sandbox-runtime/action.yml', import.meta.url), 'utf8')).runs.steps;
  const artifact = prepare.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(artifact.if, "inputs.publish-runtime == 'true' || (inputs.retain-fresh-build == 'true' && steps.runtime-cache.outputs.cache-hit != 'true' && steps.runtime-recovery.outputs.artifact-id == '')");
  assert.equal(artifact.with.name, '${{ steps.runtime-key.outputs.key }}');
  assert.ok(prepare.some(step => step.run?.includes('cache-sandbox-runtime.mjs verify runtime')));
  const restore = prepare.find(step => step.uses === 'actions/cache/restore@v4');
  assert.equal(restore.with['restore-keys'], undefined);
  assert.ok(prepare.findIndex(step => step.name === 'Verify complete sandbox cache receipt') < prepare.indexOf(artifact));
  assert.equal(jobs.runtime.if, '${{ !inputs.guest_only }}');
  assert.equal(jobs.runtime.steps.find(step => step.uses === './.github/actions/prepare-sandbox-runtime').with['publish-runtime'], '${{ inputs.publish_runtime }}');
  for (const name of ['alpha-macos-aarch64', 'alpha-windows-x64', 'release-macos-aarch64', 'ci-desktop-packaging', 'ci-engine-tests', 'ci-sandbox-validation']) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses !== 'actions/download-artifact@v4' || !JSON.stringify(step.with).includes('sandbox-runtime-')) continue;
        assert.match(step.with.pattern, /^sandbox-runtime-v2-.*-\*$/);
        assert.equal(step.with['merge-multiple'], true, 'The single native tar must retain its original consumer path');
        assert.equal(step.with.name, undefined);
      }
    }
  }
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


test('MSYS2 provisioning recovery is bounded and preserves the reviewed package installation', () => {
  const action = parse(readFileSync(new URL('../../.github/actions/build-sandbox-runtime/action.yml', import.meta.url), 'utf8'));
  const bootstraps = action.runs.steps.filter(step => step.uses === 'msys2/setup-msys2@v2');
  assert.equal(bootstraps.length, 2);
  const [initial, recovery] = bootstraps;
  assert.equal(initial['continue-on-error'], true);
  assert.equal(initial.id, 'msys2');
  assert.equal(recovery['continue-on-error'], undefined);
  assert.equal(recovery.if, "runner.os == 'Windows' && steps.msys2.outcome == 'failure'");
  assert.equal(recovery.with.location, '${{ runner.temp }}/msys2-bootstrap-retry');
  for (const step of bootstraps) assert.equal(step.with.update, true);
  assert.ok(action.runs.steps.findIndex(step => step.run?.includes('install-windows-qemu.sh')) > action.runs.steps.indexOf(recovery));
  const install = readFileSync(new URL('../sandbox/install-windows-qemu.sh', import.meta.url), 'utf8');
  assert.match(install, /sha256sum -c/);
  assert.match(install, /pacman -U --noconfirm/);
});
