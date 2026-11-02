import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { changeScope } from './change-scope.mjs';

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'), { uniqueKeys: true });
const main = workflow('ci-tests');
function condition(expression, scope, { engine = 'skipped', event = 'pull_request', inputs = {}, os = 'Linux' } = {}) {
  const needs = { changes: { result: 'success', outputs: Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, String(value)])) },
    'opencode-derivative': { result: engine }, 'engine-build-inputs': { result: 'success' } };
  const js = expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]');
  return Boolean(Function('needs', 'github', 'inputs', 'runner', 'always', 'cancelled', `return (${js});`)(needs,
    { event_name: event }, inputs, { os }, () => true, () => false));
}

test('unit jobs start independently while integration jobs require the verified engine', () => {
  const ui = changeScope(['apps/app/src/components/ui/button.tsx']);
  assert.equal(condition(main.jobs['opencode-derivative'].if, ui), false);
  assert.equal(condition(main.jobs['unit-tests'].if, ui), true);
  const steps = main.jobs['unit-tests'].steps;
  assert.equal(condition(steps.find(step => step.name === 'Run app unit tests').if, ui), true);
  const integration = main.jobs['legalwork-tests'];
  const e2e = integration.steps.find(step => step.name === 'Run e2e tests');
  assert.equal(condition(e2e.if, ui), false);
  assert.equal(steps.some(step => step.uses === './.github/actions/setup-opencode'), false);
  assert.equal(main.jobs['unit-tests'].needs, 'changes');
  assert.equal(main.jobs['unit-tests'].env.LEGALWORK_TEST_OPENCODE_BIN, '');
  const session = changeScope(['apps/app/src/react-app/domains/session/send.ts']);
  assert.equal(condition(main.jobs['opencode-derivative'].if, session), true);
  assert.equal(condition(main.jobs['unit-tests'].if, session, { engine: 'failure' }), true);
  assert.equal(condition(main.jobs['unit-tests'].if, session, { engine: 'success' }), true);
  assert.equal(condition(integration.if, ui), true);
  for (const engine of ['failure', 'cancelled', 'skipped']) assert.equal(condition(integration.if, session, { engine }), true);
  assert.equal(condition(integration.if, session, { engine: 'success' }), true);
  assert.equal(condition(e2e.if, session), true);
  assert.ok(main.jobs['ci-result'].needs.includes('unit-tests'));
  assert.ok(integration.needs.includes('unit-tests'));
  assert.ok(integration.needs.includes('opencode-derivative'));
});

test('every job compiling the server retains the reviewed Node heap budget', () => {
  for (const source of ['ci-tests', 'ci-opencode-source-hosts']) {
    const builds = Object.entries(workflow(source).jobs).filter(([, job]) =>
      job.steps?.some(step => step.run?.includes('pnpm --filter legalwork-server build')));
    assert.ok(builds.length > 0, source);
    for (const [name, job] of builds)
      assert.equal(job.env?.NODE_OPTIONS, '--max-old-space-size=6144', `${source}: ${name}`);
  }
});

test('documentation and focused manual acceptance do not accidentally launch full unit suites', () => {
  assert.equal(condition(main.jobs['unit-tests'].if, changeScope(['docs/user-guide/chat.md'])), false);
  for (const key of ['mac_signing_acceptance', 'windows_archive_acceptance', 'native_source_acceptance']) {
    assert.equal(condition(main.jobs['unit-tests'].if, changeScope(null), { engine: 'success', event: 'workflow_dispatch', inputs: { [key]: true } }), false);
  }
  assert.equal(condition(main.jobs['unit-tests'].if, changeScope(null), { engine: 'success', event: 'workflow_dispatch', inputs: { package_desktop: true } }), true);
});

test('Windows Email views retain real renderer checks and synthetic evidence in the required platform job', () => {
  const mail = changeScope(['apps/app/src/react-app/domains/mail/mail-route.tsx']);
  const server = changeScope(['apps/server/src/connectors/index.ts']);
  const job = main.jobs['windows-drafts'];
  assert.equal(condition(job.if, mail), true);
  const render = job.steps.find(step => step.name === 'Test Email views on Windows');
  assert.equal(condition(render.if, mail, {os:'Windows'}), true);
  assert.equal(condition(render.if, server, {os:'Windows'}), false);
  assert.equal(render['continue-on-error'], undefined);
  for (const file of ['mail-outbox', 'mail-compose', 'mail-keyboard-workflow', 'mail-context-render', 'mail-journey-render', 'mail-notification-open-render'])
    assert.ok(render.run.includes(`apps/app/tests/${file}.test.ts`));
  const upload = job.steps.find(step => step.with?.name === 'mail-ui-Windows');
  assert.ok(job.steps.indexOf(upload) > job.steps.indexOf(render));
  assert.ok(upload.if.includes('always()'));
  assert.equal(condition(upload.if, server, {os:'Windows'}), false);
  assert.equal(upload.with.path, '${{ runner.temp }}/mail-ui');
  assert.ok(main.jobs['ci-result'].needs.includes('windows-drafts'));
});

test('failed prerequisites cannot become successful selected-check summaries', () => {
  const summary = main.jobs['ci-result'];
  assert.equal(summary.if, 'always()');
  assert.deepEqual([...summary.needs].sort(), Object.keys(main.jobs).filter(key => key !== 'ci-result').sort());
  const script = summary.steps[0].run;
  const run = results => execFileSync('bash', ['-c', script], { env: { ...process.env, RESULTS: JSON.stringify(results) }, stdio: 'pipe' });
  assert.doesNotThrow(() => run({ build: { result: 'success' }, unrelated: { result: 'skipped' } }));
  assert.throws(() => run({ build: { result: 'failure' }, dependent: { result: 'skipped' } }));
  assert.throws(() => run({ build: { result: 'cancelled' } }));
});

test('all six package jobs retain storage checks without a duplicate six-host suite', () => {
  const packaging = workflow('ci-desktop-packaging').jobs['package-smoke'];
  const matrix = packaging.strategy.matrix.slice(3, -2).trim().replace(/inputs\.([\w-]+)/g, 'inputs["$1"]');
  const selected = Function('inputs', 'fromJSON', `return (${matrix});`)({ 'windows-only': false }, JSON.parse);
  assert.equal(selected.include.length, 6);
  const commands = packaging.steps.map(step => step.run ?? '').join('\n');
  for (const file of ['native-config-state.test.ts', 'connectors/storage-transition.test.ts', 'agent-sandbox/project-approvals.test.ts']) assert.ok(commands.includes(file));
  assert.equal(main.jobs['native-storage-acceptance'], undefined);
});

test('required PR workflows have job filtering, and reusable/manual workflows stay opt-in', () => {
  for (const name of ['ci-tests', 'ci-i18n', 'ci-docx', 'ci-legalwork-ui-mcp']) {
    assert.equal(workflow(name).on.pull_request.paths, undefined);
    assert.ok(workflow(name).jobs.changes);
  }
  for (const name of ['ci-opencode-derivative', 'ci-opencode-source-hosts', 'ci-desktop-packaging', 'ci-windows-opencode-install', 'mac-engine-signing-acceptance']) {
    assert.deepEqual(Object.keys(workflow(name).on), ['workflow_call']);
  }
  for (const file of readdirSync(new URL('../../.github/workflows/', import.meta.url))) {
    const config = workflow(file.slice(0, -4));
    for (const job of Object.values(config.jobs)) {
      for (const dependency of [job.needs ?? []].flat()) assert.ok(config.jobs[dependency], `${file}: unknown dependency ${dependency}`);
    }
  }
});
