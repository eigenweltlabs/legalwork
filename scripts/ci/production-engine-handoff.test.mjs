import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { deliveryArtifacts, retainedProductionHandoff } from './production-engine-handoff.mjs';
import { changeScope } from './change-scope.mjs';

const context = { repository: 'eigenweltlabs/legalwork', sourceRun: '42', currentRun: '99', now: Date.parse('2026-11-06T12:00:00Z') };
const artifacts = deliveryArtifacts.map((name, id) => ({ id: id + 1, name, expired: false, expires_at: '2026-11-07T12:00:00Z' }));
const retained = rows => retainedProductionHandoff(context, () => JSON.stringify({ artifacts: rows }));

test('delivery reuse requires every retained family and the complete distribution', () => {
  assert.equal(retained(artifacts), true);
  for (let i = 0; i < artifacts.length; i++) {
    assert.equal(retained(artifacts.filter((_, index) => index !== i)), false);
    for (const change of [{ expired: true }, { expires_at: '2026-11-06T12:59:59Z' }, { expires_at: 'invalid' }, { id: -1 }]) {
      assert.equal(retained(artifacts.map((row, index) => index === i ? { ...row, ...change } : row)), false);
    }
  }
  assert.equal(retained([...artifacts, artifacts[0]]), false);
  assert.throws(() => retainedProductionHandoff({ ...context, repository: 'fork/legalwork' }), /strictly equal/);
  assert.throws(() => retainedProductionHandoff({ ...context, sourceRun: '99' }), /unequal/);
});

test('delivery checks paginate before deciding whether any family is missing', () => {
  const requests = [];
  assert.equal(retainedProductionHandoff(context, endpoint => {
    requests.push(endpoint);
    return JSON.stringify({ artifacts: endpoint.endsWith('page=1')
      ? Array.from({ length: 100 }, (_, i) => ({ name: 'unrelated-' + i })) : artifacts });
  }), true);
  assert.equal(requests.length, 2);
});

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
test('native consumers follow the fully verified original producer, with fresh uploads on a missing handoff', () => {
  assert.equal(changeScope(['scripts/ci/production-engine-handoff.mjs']).engine, true);
  assert.equal(changeScope(['scripts/ci/production-engine-handoff.mjs']).alpha, true);
  const engine = workflow('ci-opencode-derivative'), build = engine.jobs.build;
  assert.equal(engine.on.workflow_call.outputs['artifact-run-id'].value, '${{ jobs.build.outputs.artifact-run-id }}');
  const verify = build.steps.findIndex(step => step.id === 'production-verified');
  const handoff = build.steps.findIndex(step => step.id === 'handoff');
  assert.ok(verify >= 0 && verify < handoff);
  assert.equal(build.steps[handoff].env.VERIFIED_MANIFEST_SHA256, '${{ steps.production-verified.outputs.manifest-sha256 }}');
  const uploads = build.steps.filter(step => step.uses === 'actions/upload-artifact@v4' && deliveryArtifacts.includes(step.with?.name));
  assert.equal(uploads.length, 4);
  for (const upload of uploads) {
    assert.equal(upload.if, "steps.handoff.outputs.reuse != 'true'");
    assert.ok(build.steps.indexOf(upload) > handoff);
    assert.equal(upload.with['retention-days'], 7);
  }
  for (const name of ['alpha-macos-aarch64', 'alpha-windows-x64', 'release-macos-aarch64']) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses !== 'actions/download-artifact@v4' || !step.with?.name?.startsWith('opencode-derivative-ci')) continue;
        assert.ok(job.needs.includes('opencode-engine'));
        assert.equal(step.with['run-id'], '${{ needs.opencode-engine.outputs.artifact-run-id }}');
        assert.equal(step.with['github-token'], '${{ github.token }}');
        assert.ok(job.steps.some(step => step.uses === './.github/actions/setup-opencode'
          && step.with['manifest-sha256'] === '${{ needs.opencode-engine.outputs.manifest-sha256 }}'));
      }
    }
  }
});

test('Mac packaging owns its native preparation while Windows cannot wait for a Mac runtime allocation', () => {
  const alpha = workflow('alpha-macos-aarch64'), jobs = alpha.jobs;
  assert.ok(!jobs['sandbox-runtime'].with.targets.includes('darwin'));
  const mac = jobs['publish-alpha-macos-aarch64'];
  const prepare = mac.steps.find(step => step.uses === './.github/actions/prepare-sandbox-runtime');
  assert.deepEqual(prepare.with, { arch: 'arm64', qemu: 'aarch64', 'wait-for-guest': 'true' });
  assert.ok(mac.steps.indexOf(prepare) < mac.steps.findIndex(step => step.name === 'Build Electron alpha app'));
  assert.ok(!mac.steps.some(step => step.with?.pattern?.includes('sandbox-runtime')));
  assert.equal(mac.steps.find(step => step.uses === './.github/actions/test-sandbox-runtime').if,
    "github.event_name == 'workflow_dispatch' && inputs.sandbox_tests");
});

test('Mac cold runtime waits for its same-run guest without blocking cache hits on Windows jobs', () => {
  const mac = workflow('alpha-macos-aarch64').jobs['publish-alpha-macos-aarch64'];
  assert.ok(!mac.needs.includes('sandbox-runtime'), 'Warm Mac packaging must remain independent of Windows builds');
  const prepare = mac.steps.find(step => step.uses === './.github/actions/prepare-sandbox-runtime');
  assert.equal(prepare.with['wait-for-guest'], 'true');
  const action = parse(readFileSync(new URL('../../.github/actions/prepare-sandbox-runtime/action.yml', import.meta.url), 'utf8'));
  assert.equal(action.inputs['wait-for-guest'].default, 'false');
  const steps = action.runs.steps;
  const recover = steps.findIndex(step => step.run?.includes('recover-sandbox-runtime.mjs restore'));
  const wait = steps.findIndex(step => step.run?.includes('recover-sandbox-runtime.mjs wait-for-guest'));
  const download = steps.findIndex(step => step.uses === 'actions/download-artifact@v4');
  assert.ok(recover >= 0 && recover < wait && wait < download, 'Cold guest download must wait after attempting runtime recovery');
  assert.equal(steps[wait].if, "inputs.wait-for-guest == 'true' && inputs.local-guest != 'true' && steps.runtime-cache.outputs.cache-hit != 'true' && steps.runtime-recovery.outputs.artifact-id == ''");
  assert.equal(steps[wait].env.GH_TOKEN, '${{ github.token }}');
});
