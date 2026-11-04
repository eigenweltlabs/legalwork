import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eligibleRecoveryRun, findRecovery, producerProof, verifyRecoveryPin } from './recover-opencode-artifact.mjs';

const context = { repository: 'eigenweltlabs/legalwork', branch: 'fixture/branch', pullRequest: 370, currentRun: '99' };
const run = { id: 42, event: 'pull_request', path: '.github/workflows/ci-tests.yml', status: 'completed',
  head_repository: { full_name: context.repository }, head_branch: context.branch, pull_requests: [{ number: 370 }] };
const key = 'opencode-development-v1-' + 'a'.repeat(64), pin = 'b'.repeat(64);
const log = `2026-11-04T12:00:00Z key=${key}\n2026-11-04T12:01:00Z manifest-sha256=${pin}\n`;

test('artifact recovery cannot cross repository, PR, branch, workflow or unfinished run boundaries', () => {
  assert.equal(eligibleRecoveryRun(run, context), true);
  for (const change of [{ id: 99 }, { id: '42' }, { event: 'push' }, { status: 'in_progress' },
    { path: '.github/workflows/other.yml' }, { head_branch: 'other' }, { pull_requests: [] },
    { head_repository: { full_name: 'fork/legalwork' } }]) assert.equal(eligibleRecoveryRun({ ...run, ...change }, context), false);
  assert.equal(eligibleRecoveryRun(run, { ...context, repository: 'fork/legalwork' }), false);
  assert.equal(producerProof(log, key), pin);
  assert.equal(producerProof(log, key.replace(/a/g, 'c')), undefined);
  assert.equal(producerProof(log + `2026-11-04T12:02:00Z manifest-sha256=${'c'.repeat(64)}\n`, key), undefined);
  assert.equal(producerProof(`echo manifest-sha256=${pin}\n`, key), undefined);
});

test('only a completed successful producer with retained full archives supplies an independent pin', async () => {
  const event = { pull_request: { number: 370, head: { repo: { full_name: context.repository }, ref: context.branch } } };
  const input = { event, repository: context.repository, currentRun: context.currentRun, expectedKey: key };
  const jobs = { total_count: 1, jobs: [{ id: 7, name: 'opencode-derivative / build', status: 'completed', conclusion: 'success', steps: [{ name: 'Verify all development archives against current source policy', conclusion: 'success' }] }] };
  const artifacts = { total_count: 1, artifacts: [{ id: 8, name: 'opencode-derivative-ci', expired: false }] };
  const reader = (jobData = jobs, archiveData = artifacts) => endpoint => {
    if (endpoint.includes('/workflows/')) return JSON.stringify({ workflow_runs: [run] });
    if (endpoint.endsWith('/logs')) return log;
    return JSON.stringify(endpoint.includes('/jobs?') ? jobData : archiveData);
  };
  assert.deepEqual(await findRecovery(input, reader()), { runID: '42', jobID: 7, manifestSha256: pin, artifactID: 8 });
  for (const jobData of [{ total_count: 2, jobs: jobs.jobs }, { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }] }, { ...jobs, jobs: [{ ...jobs.jobs[0], steps: [] }] }]) assert.equal(await findRecovery(input, reader(jobData)), undefined);
  assert.equal(await findRecovery(input, reader(jobs, { ...artifacts, artifacts: [{ ...artifacts.artifacts[0], expired: true }] })), undefined);
  assert.equal(await findRecovery({ ...input, event: { pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: { full_name: 'fork/legalwork' } } } } }, () => { throw Error('Must not query fork recovery'); }), undefined);
});

test('artifact bytes cannot nominate a different manifest or receipt after producer-log pinning', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'engine-recovery-pin-'));
  const manifest = '{"fixture":"complete distribution"}\n';
  const expected = createHash('sha256').update(manifest).digest('hex');
  try {
    await writeFile(path.join(directory, 'derivative-release.json'), manifest);
    await writeFile(path.join(directory, 'distribution-receipt.json'), JSON.stringify({ manifestSha256: expected }));
    await verifyRecoveryPin(directory, expected);
    await assert.rejects(verifyRecoveryPin(directory, pin), /independent producer log/);
    await writeFile(path.join(directory, 'distribution-receipt.json'), JSON.stringify({ manifestSha256: pin }));
    await assert.rejects(verifyRecoveryPin(directory, expected), /same independent pin/);
    await rm(path.join(directory, 'distribution-receipt.json'));
    await symlink(path.join(directory, 'derivative-release.json'), path.join(directory, 'distribution-receipt.json'));
    await assert.rejects(verifyRecoveryPin(directory, expected), /ordinary files/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production always compiles fresh while recovered development bytes still pass the full verifier', () => {
  const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ci-opencode-derivative.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const recovery = steps.findIndex(step => step.id === 'artifact-source');
  assert.match(steps[recovery].if, /inputs.build-mode == 'development'/);
  assert.match(steps[recovery].if, /github.event_name == 'pull_request'/);
  const pinned = steps.findIndex(step => step.name === 'Check the recovered manifest against the independent producer log');
  const verified = steps.findIndex(step => step.name === 'Verify all development archives against current source policy');
  const saved = steps.findIndex(step => step.uses === 'actions/cache/save@v4');
  assert.ok(recovery < pinned && pinned < verified && verified < saved);
  assert.equal(steps[pinned]['continue-on-error'], undefined);
  assert.match(steps[verified].run, /cache-opencode-derivative.mjs verify/);
  const compile = steps.find(step => step.id === 'engine').if;
  const js = compile.replace(/inputs\.([\w-]+)/g, 'inputs["$1"]').replace(/steps\.([\w-]+)/g, 'steps["$1"]').replace(/outputs\.([\w-]+)/g, 'outputs["$1"]');
  const selected = (mode, hit, recovered) => Function('inputs', 'steps', `return ${js};`)({ 'build-mode': mode },
    { mode: { outputs: { reuse: 'false' } }, cache: { outputs: { 'cache-hit': hit } }, 'artifact-source': { outputs: { 'run-id': recovered } } });
  assert.equal(selected('production', 'true', '42'), true);
  assert.equal(selected('development', 'true', ''), false);
  assert.equal(selected('development', 'false', '42'), false);
  assert.equal(selected('development', 'false', ''), true);
});
