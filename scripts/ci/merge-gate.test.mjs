import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeDiff, mergePlan, portableAreas } from './merge-plan.mjs';
import { lastPublished, alphaTargets } from './alpha-candidate.mjs';
import { enableDevQueue, queuedRuleset } from './dev-queue-ruleset.mjs';

test('bundled help, ordinary SDK consumers and typed UI are portable; engine policy and shared VM changes use native checks', () => {
  const docs = ['apps/server/src/core-skills.ts', 'docs/user-guide/chat.md'];
  assert.deepEqual(mergePlan(docs), { fullEngine: false, focused: [], targets: [] });
  assert.deepEqual(portableAreas(docs), []);
  assert.deepEqual(portableAreas(['packages/openui/src/catalog.tsx']), ['app', 'openui']);
  assert.equal(mergePlan(['apps/server/package.json'], { engineDepsChanged: false }).fullEngine, false);
  assert.equal(mergePlan(['apps/server/src/managed-opencode.ts']).fullEngine, true);
  assert.equal(mergePlan(['apps/server/src/opencode-plugins/pdf-reading.integration.test.ts'], {
    realTests: ['apps/server/src/opencode-plugins/pdf-reading.integration.test.ts'],
  }).focused.length, 1);
  assert.deepEqual(mergePlan(['apps/server/src/agent-sandbox/host-windows.ts']).targets, ['win32']);
  assert.deepEqual(mergePlan(['apps/server/src/agent-sandbox/permissions.ts']).targets, ['linux', 'darwin', 'win32']);
  assert.deepEqual(mergePlan(['apps/new-component/src/foo.ts']), mergePlan(null));
});

test('queue range includes each PR, tracks deleted paths and reads changed dependency versions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-group-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const put = (file, value) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), value); };
  const commit = () => { git('add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    put('package.json', '{\n "effect": "1",\n "pdf-lib": "1"\n}\n');
    put('apps/server/src/agent-sandbox/permissions.ts', 'old'); const base = commit();
    put('package.json', '{\n "effect": "1",\n "pdf-lib": "2"\n}\n'); const pr = commit();
    rmSync(path.join(root, 'apps/server/src/agent-sandbox/permissions.ts')); const group = commit();
    put('package.json', '{\n "effect": "2",\n "pdf-lib": "2"\n}\n'); const engine = commit();
    const planModule = new URL('./merge-plan.mjs', import.meta.url);
    const diff = (event, head) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      'import { mergeDiff } from ' + JSON.stringify(planModule.href) + '; console.log(JSON.stringify(mergeDiff()))'], { cwd: root,
      env: { ...process.env, EVENT_NAME: event, BASE_SHA: base, HEAD_SHA: head } }));
    assert.deepEqual(diff('pull_request', pr), { files: ['package.json'], engineDepsChanged: false });
    const result = diff('merge_group', group);
    assert.deepEqual(result.files, ['apps/server/src/agent-sandbox/permissions.ts', 'package.json']);
    assert.deepEqual(mergePlan(result.files, result).targets, ['linux', 'darwin', 'win32']);
    assert.equal(diff('merge_group', engine).engineDepsChanged, true);
    assert.throws(() => mergeDiff({ BASE_SHA: '', HEAD_SHA: group }), /Cannot resolve/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('coalesced alpha candidates only skip changes already published on all supported targets', () => {
  const runs = ['superseded', 'docs', 'partial', 'published'].map(id => ({ id, head_sha: id, event: 'push', head_branch: 'dev', conclusion: 'success' }));
  const jobs = id => alphaTargets.slice(0, id === 'partial' ? 2 : 3).map(target => ({ name: 'Build + Publish alpha (' + target + ')',
    conclusion: id === 'docs' ? 'skipped' : 'success', steps: [{ name: 'Publish complete alpha', conclusion: 'success' }] }));
  assert.equal(lastPublished(runs, jobs, sha => sha !== 'superseded'), 'published');
  assert.equal(lastPublished(runs.slice(1, 3), jobs, () => true), undefined);
});

test('queue payload preserves protection and fails closed on unexpected branch coverage or required checks', () => {
  const protection = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
    required_status_checks: ['ubuntu-latest', 'macos-14'].map(os => ({ context: 'legalwork-tests (' + os + ')', integration_id: 15368 })) } };
  const before = { name: 'prod', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
    bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }, protection] };
  const after = queuedRuleset(before);
  assert.equal(after.rules[2].parameters.strict_required_status_checks_policy, false);
  assert.deepEqual(after.rules[2].parameters.required_status_checks, protection.parameters.required_status_checks);
  assert.deepEqual(after.rules.slice(0, 2), before.rules.slice(0, 2));
  assert.equal(after.rules[3].parameters.grouping_strategy, 'ALLGREEN');
  assert.deepEqual(queuedRuleset(after), after);
  assert.throws(() => queuedRuleset({ ...before, conditions: { ref_name: { include: ['~ALL'], exclude: [] } } }));
  const handler = Buffer.from('on:\n  merge_group:\n    types: [checks_requested]\n    branches: [dev]\n');
  let live = before, writes = 0;
  const gh = (args, input) => {
    if (args[1].includes('/contents/')) return JSON.stringify({ content: handler.toString('base64') });
    if (args.includes('PUT')) { live = JSON.parse(input); writes++; }
    return JSON.stringify(live);
  };
  assert.throws(() => enableDevQueue(gh, Buffer.from('old route')), /landed dev/);
  enableDevQueue(gh, handler);
  enableDevQueue(gh, handler);
  assert.equal(writes, 1);
  protection.parameters.required_status_checks.push({ context: 'unknown' });
  assert.throws(() => queuedRuleset(before));
});

test('affected test selection follows a dependency and preserves the owning suite for a deleted file', async () => {
  const { affectedTests } = await import('./affected-tests.mjs');
  const selected = affectedTests('server', ['apps/server/src/project-templates.ts']);
  assert.ok(selected.some(file => file.endsWith('/project-templates.e2e.test.ts')));
  assert.ok(selected.every(file => file.startsWith(path.resolve('apps/server/'))));
  assert.equal(affectedTests('server', ['apps/server/src/deleted-source.ts']), null);
});

test('timings count failed gates and require signed availability on all three platforms', async () => {
  const { gateTiming } = await import('./gate-timings.mjs');
  const start = '2026-11-01T00:00:00Z', end = '2026-11-01T00:04:59Z';
  const run = { event: 'pull_request', created_at: start };
  const gates = ['ubuntu-latest', 'macos-14'].map(os => ({ name: 'legalwork-tests (' + os + ')', conclusion: 'success', completed_at: end }));
  assert.equal(gateTiming(run, gates).seconds, 299);
  assert.equal(gateTiming(run, gates.slice(1)).seconds, null);
  const success = name => ({ name, conclusion: 'success', completed_at: end });
  const builds = alphaTargets.map((target, i) => ({ name: 'Build + Publish alpha (' + target + ')', conclusion: 'success',
    steps: [success(i ? 'Verify signed Windows artifacts' : 'Package Electron alpha (macOS, signed + notarized)'), success('Publish complete alpha')] }));
  const producer = { steps: [success('Download the independently pinned production engine cache')] };
  assert.equal(gateTiming({ ...run, event: 'push' }, builds), null);
  assert.deepEqual(gateTiming({ ...run, event: 'push' }, [...builds, producer]), { kind: 'warm-alpha', seconds: 299 });
  assert.equal(gateTiming({ ...run, event: 'push' }, [...builds.slice(1), producer]).seconds, null);
});

test('report only failed steps that passed on a rerun of the same run', async () => {
  const { recoveredSteps } = await import('./gate-timings.mjs');
  const red = { name: 'portable (app)', conclusion: 'failure', steps: [
    { name: 'Install', conclusion: 'success' }, { name: 'Run fixtures', conclusion: 'failure' }] };
  assert.deepEqual(recoveredSteps([red], [red]), []);
  assert.deepEqual(recoveredSteps([red], [{ name: red.name, conclusion: 'success' }]), [{ job: red.name, step: 'Run fixtures' }]);
});
