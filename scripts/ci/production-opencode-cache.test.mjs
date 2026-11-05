import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eligibleProductionRun, findProductionCache, productionCacheKey, productionProducerProof, productionVerificationStep, verifyProductionEngine } from './production-opencode-cache.mjs';
import { changeScope } from './change-scope.mjs';
import { writeFixtureDerivativeDistribution } from '../../packages/opencode-release/test-fixture.mjs';
import { sourceBuildIdentity } from '../../packages/opencode-release/build/prepare.mjs';
import { assembleDerivativeDistribution } from '../../packages/opencode-release/build/distribution.mjs';
import { macEntitlementsSha256 } from '../../packages/opencode-release/build/mac-signing.mjs';
import { sha256 } from '../../packages/opencode-release/build/candidate.mjs';
import recipe from '../../packages/opencode-release/build/recipe.json' with { type: 'json' };

const context = { repository: 'eigenweltlabs/legalwork', currentRun: '99', event: 'push', branch: 'dev' };
const run = { id: 42, event: 'push', path: '.github/workflows/alpha-macos-aarch64.yml', status: 'completed',
  head_repository: { full_name: context.repository }, head_branch: 'dev' };
const key = 'opencode-production-v1-' + 'a'.repeat(64), pin = 'b'.repeat(64);
const log = `2026-11-05T12:00:00Z production-cache-key=${key}\n2026-11-05T12:01:00Z manifest-sha256=${pin}\n`;

test('production cache identity is complete and separates source, signer, producer and development mode', () => {
  const identity = { mode: 'production', sourceKey: 'a'.repeat(64), targets: recipe.targets, signer: { certificate: 'one' } };
  const first = productionCacheKey(identity, { producer: 'one' });
  assert.equal(first, productionCacheKey(structuredClone(identity), { producer: 'one' }));
  for (const replacement of [{ sourceKey: 'b'.repeat(64) }, { signer: { certificate: 'two' } }]) {
    assert.notEqual(first, productionCacheKey({ ...identity, ...replacement }, { producer: 'one' }));
  }
  assert.notEqual(first, productionCacheKey(identity, { producer: 'two' }));
  assert.throws(() => productionCacheKey({ ...identity, mode: 'development' }, {}), /production intent/);
  assert.throws(() => productionCacheKey({ ...identity, targets: ['darwin-arm64'] }, {}), /twelve/);
  assert.equal(changeScope(['scripts/ci/production-opencode-cache.mjs']).engine, true);
});

test('production producers cannot cross repository, PR or untrusted branch boundaries', () => {
  assert.equal(eligibleProductionRun(run, context), true);
  for (const change of [{ id: 99 }, { id: '42' }, { event: 'pull_request' }, { event: 'pull_request_target' },
    { status: 'in_progress' }, { head_branch: 'feature/other' }, { path: '.github/workflows/ci-tests.yml' },
    { head_repository: { full_name: 'fork/legalwork' } }]) assert.equal(eligibleProductionRun({ ...run, ...change }, context), false);
  assert.equal(eligibleProductionRun({ ...run, event: 'workflow_dispatch', head_branch: 'v1.2.3' }, context), false);
  assert.equal(eligibleProductionRun({ ...run, event: 'release', path: '.github/workflows/release-macos-aarch64.yml' }, context), true);
  const manual = { ...run, event: 'workflow_dispatch', head_branch: 'codex/fixture' };
  assert.equal(eligibleProductionRun(manual, context), false);
  assert.equal(eligibleProductionRun(manual, { ...context, event: 'workflow_dispatch', branch: 'codex/fixture' }), true);
  assert.equal(eligibleProductionRun(manual, { ...context, event: 'workflow_dispatch', branch: 'codex/other' }), false);
  assert.equal(eligibleProductionRun({ ...manual, head_branch: undefined }, { ...context, event: 'workflow_dispatch', branch: undefined }), false);
});

test('discovery requires an independent unambiguous producer pin and successful full verification', async () => {
  const artifact = { id: 8, name: key, expired: false, workflow_run: { id: 42 } };
  const jobs = { total_count: 1, jobs: [{ id: 7, name: 'opencode-engine / build', status: 'completed', conclusion: 'success',
    steps: [{ name: productionVerificationStep, conclusion: 'success' }] }] };
  const reader = (overrides = {}) => endpoint => {
    if (endpoint.includes('/artifacts?')) return JSON.stringify({ artifacts: [artifact], ...overrides.artifacts });
    if (endpoint.endsWith('/logs')) return overrides.log ?? log;
    return JSON.stringify(endpoint.includes('/jobs?') ? overrides.jobs ?? jobs : { ...run, ...overrides.run });
  };
  const input = { ...context, expectedKey: key };
  assert.deepEqual(await findProductionCache(input, reader()), { runID: '42', jobID: 7, artifactID: 8, manifestSha256: pin });
  for (const overrides of [
    { artifacts: { artifacts: [{ ...artifact, expired: true }] } },
    { artifacts: { artifacts: [{ ...artifact, name: 'opencode-derivative-ci' }] } },
    { run: { head_branch: 'codex/untrusted' } }, { run: { event: 'pull_request' } },
    { jobs: { ...jobs, total_count: 2 } },
    { jobs: { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }] } },
    { jobs: { ...jobs, jobs: [{ ...jobs.jobs[0], steps: [] }] } },
    { log: log.replace(key, key.replaceAll('a', 'c')) },
    { log: log + `2026-11-05T12:02:00Z manifest-sha256=${'c'.repeat(64)}\n` },
  ]) assert.equal(await findProductionCache(input, reader(overrides)), undefined);
  await assert.rejects(findProductionCache({ ...input, event: 'pull_request' }, () => { throw Error('Must not query PR cache'); }), /PRs/);
  assert.equal(productionProducerProof('\x1b[31m' + log + '\x1b[0m', key), pin);
  assert.equal(productionProducerProof(log.replace('production-cache-key=', 'echo production-cache-key='), key), undefined);
});

test('discovery paginates exact artifact names rather than limiting reuse to recent app runs', async () => {
  const requests = [];
  const found = await findProductionCache({ ...context, expectedKey: key }, endpoint => {
    requests.push(endpoint);
    if (endpoint.includes('/artifacts?')) return JSON.stringify({ artifacts: endpoint.endsWith('page=1')
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: key, expired: true }))
      : [{ id: 200, name: key, expired: false, workflow_run: { id: 42 } }] });
    if (endpoint.endsWith('/logs')) return log;
    if (endpoint.includes('/jobs?')) return JSON.stringify({ total_count: 1, jobs: [{ id: 7, name: 'opencode-engine / build', status: 'completed',
      conclusion: 'success', steps: [{ name: productionVerificationStep, conclusion: 'success' }] }] });
    return JSON.stringify(run);
  });
  assert.equal(found.artifactID, 200);
  assert.equal(requests.filter(value => value.includes('/artifacts?')).length, 2);
});

test('the required-hit CLI fails instead of silently producing a cold benchmark', () => {
  const script = new URL('./production-opencode-cache.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, 'find'], { encoding: 'utf8', env: { ...process.env,
    FORCE_REBUILD: 'true', REQUIRE_CACHE_HIT: 'true', EXPECTED_KEY: key } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verified production cache hit is required/);
});

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
test('a cache hit skips compilation/private-key import but cannot skip full production verification', () => {
  const build = workflow('ci-opencode-derivative').jobs.build, steps = build.steps;
  const compile = steps.find(step => step.id === 'engine').if;
  const js = compile.replace(/inputs\.([\w-]+)/g, 'inputs["$1"]').replace(/steps\.([\w-]+)/g, 'steps["$1"]').replace(/outputs\.([\w-]+)/g, 'outputs["$1"]');
  const selected = (mode, productionHit, developmentHit = '', recovered = '') => Function('inputs', 'steps', `return ${js};`)(
    { 'build-mode': mode }, { mode: { outputs: { reuse: 'false' } }, 'production-source': { outputs: { 'cache-hit': productionHit } },
      cache: { outputs: { 'cache-hit': developmentHit } }, 'artifact-source': { outputs: { 'run-id': recovered } } });
  assert.equal(selected('production', 'true'), false);
  assert.equal(selected('production', 'false', 'true', '42'), true);
  assert.equal(selected('development', 'true', 'false'), true);
  assert.equal(selected('development', '', 'true'), false);
  assert.equal(selected('development', '', 'false', '42'), false);
  const verify = steps.findIndex(step => step.name === productionVerificationStep);
  const retain = steps.findIndex(step => step.name === 'Retain the verified immutable production engine cache');
  const deliver = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4' && step.with?.name === 'opencode-derivative-ci');
  assert.equal(steps[verify].if, "inputs.build-mode == 'production'");
  assert.equal(steps[verify]['continue-on-error'], undefined);
  assert.ok(verify < retain && retain < deliver);
  assert.equal(steps[retain].with['retention-days'], 90);
  assert.match(steps.find(step => step.id === 'identity').if, /cache-hit != 'true'/);
  assert.match(build.outputs['manifest-sha256'], /production-verified/);
  const source = readFileSync(new URL('./production-opencode-cache.mjs', import.meta.url), 'utf8');
  assert.match(source, /verifyRecoveryPin\(directory, manifestSha256\)/);
  assert.match(source, /mode: 'production', targets: recipe.targets/);
  assert.match(source, /assert.equal\(process.platform, 'darwin'/);
});

test('a valid development distribution cannot become a production cache hit', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-cache-negative-'));
  try {
    const fixture = await writeFixtureDerivativeDistribution(root);
    const identity = await sourceBuildIdentity({ mode: 'production', targets: recipe.targets });
    for (const build of fixture.builds) {
      const filename = path.join(build.directory, 'provenance.json');
      const provenance = JSON.parse(await readFile(filename, 'utf8'));
      provenance.build = { wrapperSha256: identity.files['build/candidate.mjs'], signingHelperSha256: identity.files['build/mac-signing.mjs'],
        signingEntitlementsSha256: macEntitlementsSha256, recipeSha256: identity.files['build/recipe.json'], buildSha256: provenance.binary.sha256 };
      const bytes = JSON.stringify(provenance) + '\n';
      await writeFile(filename, bytes); build.provenanceSha256 = sha256(bytes);
      const binary = build.target.startsWith('windows-') ? 'opencode.exe' : 'opencode';
      await writeFile(path.join(build.directory, 'SHA256SUMS'), `${provenance.binary.sha256}  ${binary}\n${sha256(bytes)}  provenance.json\n`);
    }
    await rm(fixture.archives, { recursive: true });
    const result = await assembleDerivativeDistribution({ builds: fixture.builds, outputDirectory: fixture.archives,
      manifestPath: path.join(root, 'derivative-release.json'), onProgress: () => {} });
    await writeFile(path.join(root, 'distribution-receipt.json'), JSON.stringify(result));
    await assert.rejects(verifyProductionEngine(root, result.manifestSha256), /exact pre-pin signing evidence/);
    await assert.rejects(verifyProductionEngine(root, 'f'.repeat(64)), /independent producer log pin/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('engine-only warm-up cannot masquerade as a full cache-hit alpha benchmark or publish releases', () => {
  const alpha = workflow('alpha-macos-aarch64'), guard = alpha.jobs.changes.steps.find(step => step.name === 'Require benchmark inputs to be nonpublishing');
  const run = env => spawnSync('bash', ['-e', '-c', guard.run], { env: { ...process.env, PROFILE: 'optimized', VERSION: '', LINUX_BENCHMARK: 'false',
    WARM_ENGINE_CACHE: 'false', REQUIRE_ENGINE_CACHE: 'false', ...env } }).status;
  assert.equal(run({ SIGNING_TEST: 'false', WARM_ENGINE_CACHE: 'true' }), 1);
  assert.equal(run({ SIGNING_TEST: 'false', REQUIRE_ENGINE_CACHE: 'true' }), 1);
  assert.equal(run({ SIGNING_TEST: 'true', WARM_ENGINE_CACHE: 'true', REQUIRE_ENGINE_CACHE: 'true' }), 1);
  assert.equal(run({ SIGNING_TEST: 'true', REQUIRE_ENGINE_CACHE: 'true', PROFILE: 'serial-full-ui' }), 1);
  assert.equal(run({ SIGNING_TEST: 'true', WARM_ENGINE_CACHE: 'true' }), 0);
  assert.equal(run({ SIGNING_TEST: 'true', REQUIRE_ENGINE_CACHE: 'true' }), 0);
  for (const name of ['sandbox-runtime', 'portable-version']) assert.match(alpha.jobs[name].if, /github.event_name == 'workflow_dispatch' && inputs.warm_engine_cache/);
  for (const name of ['publish-alpha-macos-aarch64', 'publish-alpha-windows']) {
    assert.ok(alpha.jobs[name].needs.includes('sandbox-runtime') && alpha.jobs[name].needs.includes('portable-version'));
  }
  assert.match(alpha.jobs['opencode-engine'].with['require-production-cache-hit'], /inputs.require_engine_cache/);
});
