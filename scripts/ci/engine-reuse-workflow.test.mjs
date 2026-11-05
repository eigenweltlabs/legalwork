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
  const integration = workflow('ci-tests').jobs['legalwork-tests'];
  const serverTests = integration.steps.find(step => step.name === 'Run server engine integration tests');
  assert.equal(serverTests.if, "needs.changes.outputs.server == 'true'");
  assert.match(serverTests.run, /run-engine-tests.mjs/);
  const files = engineTestFiles(fileURLToPath(new URL('../../apps/server/src', import.meta.url)));
  for (const suffix of ['managed-opencode.released.test.ts', 'scheduled-tasks/engine.test.ts', 'managed-opencode.search.e2e.test.ts', 'opencode-plugins/pdf-reading.integration.test.ts']) assert.ok(files.some(filename => filename.endsWith(suffix)), suffix);
});

test('existing required check names fail if units or a selected engine build fail', () => {
  const gate = workflow('ci-tests').jobs['legalwork-tests'];
  assert.deepEqual(gate.strategy.matrix.os, ['ubuntu-latest', 'macos-14']);
  for (const name of ['unit-tests', 'legalwork-tests', 'sandbox-engine']) {
    assert.equal(workflow('ci-tests').jobs[name]['runs-on'], "${{ matrix.os == 'macos-14' && 'macos-15' || matrix.os }}");
  }
  const script = gate.steps[0].run;
  const run = (units, required, engine) => execFileSync('bash', ['-e', '-c', script], {
    env: { ...process.env, UNIT_RESULT: units, ENGINE_REQUIRED: required, ENGINE_RESULT: engine }, stdio: 'pipe',
  });
  assert.doesNotThrow(() => run('success', 'false', 'skipped'));
  assert.doesNotThrow(() => run('success', 'true', 'success'));
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.throws(() => run(result, 'false', 'skipped'));
    assert.throws(() => run('success', 'true', result));
  }
});
