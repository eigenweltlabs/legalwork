import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { changeScope } from './change-scope.mjs';

const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'), { uniqueKeys: true });
const main = workflow('ci-tests');
function condition(expression, scope, { engine = 'skipped', event = 'pull_request', inputs = {}, os = 'Linux', sandbox = 'skipped', guest = 'skipped', labels = [] } = {}) {
  const needs = { changes: { result: 'success', outputs: Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, String(value)])) },
    'opencode-derivative': { result: engine }, 'sandbox-runtime': { result: sandbox }, 'sandbox-guest-x64': { result: guest }, 'sandbox-guest-arm64': { result: guest }, 'pr-renderer': { result: 'success' }, 'engine-build-inputs': { result: 'success' } };
  const js = expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]').replace(/inputs\.([\w-]+)/g, 'inputs["$1"]').replace('github.event.pull_request.labels.*.name', 'github.event.pull_request.labels.map(label => label.name)');
  return Boolean(Function('needs', 'github', 'inputs', 'runner', 'always', 'cancelled', 'contains', `return (${js});`)(needs,
    { event_name: event, event: { pull_request: { labels: labels.map(name => ({ name })) } } }, inputs, { os }, () => true, () => false, (values, value) => values.includes(value)));
}

test('unit jobs start independently while integration jobs require the verified engine', () => {
  const ui = changeScope(['apps/app/src/components/ui/button.tsx']);
  assert.equal(condition(main.jobs['opencode-derivative'].if, ui), false);
  assert.equal(condition(main.jobs['unit-tests'].if, ui), true);
  const steps = main.jobs['unit-tests'].steps;
  assert.equal(condition(steps.find(step => step.name === 'Run app unit tests').if, ui), true);
  const integration = workflow('ci-engine-tests').jobs.tests;
  const engineJob = main.jobs['engine-tests-mac'];
  const e2e = integration.steps.find(step => step.name === 'Run e2e tests');
  assert.equal(condition(e2e.if, ui, { inputs: { app: false, server: false, 'engine-required': true } }), false);
  assert.equal(steps.some(step => step.uses === './.github/actions/setup-opencode'), false);
  assert.deepEqual(main.jobs['unit-tests'].needs, ['changes', 'pr-renderer']);
  assert.equal(main.jobs['unit-tests'].env.LEGALWORK_TEST_OPENCODE_BIN, '');
  const session = changeScope(['apps/app/src/react-app/domains/session/send.ts']);
  assert.equal(condition(main.jobs['opencode-derivative'].if, session), true);
  assert.equal(condition(main.jobs['unit-tests'].if, session, { engine: 'failure' }), true);
  assert.equal(condition(main.jobs['unit-tests'].if, session, { engine: 'success' }), true);
  assert.equal(condition(engineJob.if, ui), false);
  for (const engine of ['failure', 'cancelled', 'skipped']) assert.equal(condition(engineJob.if, session, { engine }), true);
  assert.equal(condition(engineJob.if, session, { engine: 'success' }), true);
  assert.equal(condition(e2e.if, session, { inputs: { app: true, server: true, 'engine-required': true } }), true);
  assert.ok(main.jobs['ci-result'].needs.includes('unit-tests'));
  assert.ok(!engineJob.needs.includes('unit-tests'));
  assert.ok(main.jobs['legalwork-tests'].needs.includes('unit-tests'));
  assert.ok(main.jobs['legalwork-tests'].needs.includes('engine-tests-mac'));
  assert.ok(main.jobs['legalwork-tests'].needs.includes('engine-tests-linux'));
  assert.ok(engineJob.needs.includes('opencode-derivative'));
});

test('Linux unit workers keep registered OAuth callback ports out of ephemeral allocation', () => {
  const steps = main.jobs['unit-tests'].steps;
  const reserve = steps.find(step => step.name === 'Reserve fixed sign-in ports from Linux ephemeral allocation');
  assert.equal(condition(reserve.if, changeScope(null)), true);
  assert.equal(condition(reserve.if, changeScope(null), { os: 'macOS' }), false);
  assert.equal(condition(reserve.if, changeScope(['apps/app/src/components/ui/button.tsx'])), false);
  assert.ok(steps.indexOf(reserve) < steps.findIndex(step => step.name === 'Install dependencies'));
  const source = readFileSync(new URL('../../apps/server/src/eigenwelt-auth.ts', import.meta.url), 'utf8');
  const ports = JSON.parse(source.match(/EIGENWELT_LOOPBACK_PORTS = (\[[\d, ]+\])/)[1]);
  assert.deepEqual(ports, [43117, 43118, 43119], 'Update the reserved range when the registered redirect ports change');
  const directory = mkdtempSync(path.join(tmpdir(), 'ci-callback-reservation-'));
  try {
    for (const existing of ['', '30000-30005,45000']) {
      writeFileSync(path.join(directory, 'cat'), '#!/bin/sh\nprintf "%s" "$EXISTING_RESERVED_PORTS"\n', { mode: 0o755 });
      writeFileSync(path.join(directory, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const result = execFileSync('bash', ['-eu', '-c', reserve.run], { encoding: 'utf8', env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, EXISTING_RESERVED_PORTS: existing } });
      assert.equal(result, `sysctl\n-w\nnet.ipv4.ip_local_reserved_ports=${existing ? existing + ',' : ''}43117-43119\n`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('documentation and focused manual acceptance do not accidentally launch full unit suites', () => {
  assert.equal(condition(main.jobs['unit-tests'].if, changeScope(['docs/user-guide/chat.md'])), false);
  for (const key of ['mac_signing_acceptance', 'windows_archive_acceptance', 'native_source_acceptance']) {
    assert.equal(condition(main.jobs['unit-tests'].if, changeScope(null), { engine: 'success', event: 'workflow_dispatch', inputs: { [key]: true } }), false);
  }
  assert.equal(condition(main.jobs['unit-tests'].if, changeScope(null), { engine: 'success', event: 'workflow_dispatch', inputs: { package_desktop: true } }), true);
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
  const matrix = packaging.strategy.matrix.slice(3, -2).trim().replace(/inputs\.([\w-]+)/g, 'inputs["$1"]').replace('github.event.pull_request.labels.*.name', 'github.event.pull_request.labels.map(label => label.name)');
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
  for (const name of ['ci-opencode-derivative', 'ci-opencode-source-hosts', 'ci-desktop-packaging', 'ci-windows-opencode-install', 'mac-engine-signing-acceptance', 'ci-engine-tests', 'ci-sandbox-validation']) {
    assert.deepEqual(Object.keys(workflow(name).on), ['workflow_call']);
  }
  for (const file of readdirSync(new URL('../../.github/workflows/', import.meta.url))) {
    const config = workflow(file.slice(0, -4));
    for (const job of Object.values(config.jobs)) {
      for (const dependency of [job.needs ?? []].flat()) assert.ok(config.jobs[dependency], `${file}: unknown dependency ${dependency}`);
    }
  }
});


test('PR targets prepare and validate their own native bytes without a global host barrier', () => {
  assert.equal(main.jobs['sandbox-engine'], undefined);
  assert.match(main.jobs['sandbox-runtime'].if, /github.event_name == 'workflow_dispatch'/);
  const validators = Object.entries(main.jobs).filter(([id]) => id.startsWith('sandbox-validation-'));
  const engines = Object.entries(main.jobs).filter(([id]) => id.startsWith('engine-tests-'));
  const targets = [];
  for (const [id, job] of [...validators, ...engines]) {
    const arch = job.with.arch;
    const guest = `sandbox-guest-${arch}`;
    assert.ok(job.needs.includes(guest), id);
    assert.ok(!job.needs.includes(`sandbox-guest-${arch === 'x64' ? 'arm64' : 'x64'}`), id);
    const prepare = main.jobs[guest];
    assert.equal(prepare.with.guest_only, true);
    assert.equal(prepare.with.publish_runtime, false);
    assert.equal(prepare.with.targets, `linux-${arch}`);
    assert.equal(condition(prepare.if, changeScope(null)), true);
    assert.equal(condition(prepare.if, changeScope(null), { labels: ['skip-sandbox-tests'] }), false);
    assert.equal(condition(prepare.if, changeScope(null), { event: 'workflow_dispatch' }), false);
    const platform = job.with.platform ?? (arch === 'arm64' ? 'darwin' : 'linux');
    targets.push(`${platform}-${arch}`);
    const body = workflow(job.uses.split('/').at(-1).slice(0, -4)).jobs.tests;
    assert.ok(body.steps.some(step => step.uses === './.github/actions/prepare-sandbox-runtime'), id);
    assert.ok(body.steps.some(step => step.uses === './.github/actions/test-sandbox-runtime'), id);
    assert.ok(body.steps.some(step => step.name === 'Unpack exact same-run runtime'), id);
    for (const gate of ['legalwork-tests', 'ci-result']) assert.ok(main.jobs[gate].needs.includes(id));
  }
  assert.deepEqual(targets.sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  const integration = workflow('ci-engine-tests').jobs.tests;
  const validate = integration.steps.find(step => step.uses === './.github/actions/test-sandbox-runtime');
  assert.equal(validate.if, 'inputs.runtime-required');
  const protectedStep = integration.steps.find(step => step.name === 'Verify the shipped engine uses protected execution');
  assert.equal(protectedStep.env.LEGALWORK_SANDBOX_INTEGRATION, '1');
  assert.ok(protectedStep.run.includes('agent-sandbox/engine.integration.test.ts'));
  assert.ok(!protectedStep.run.includes('legalwork-skill-resources.integration.test.ts'));
  const resources = integration.steps.find(step => step.name === 'Verify workflow resources with the shipped engine');
  assert.equal(condition(resources.if, changeScope(null), { inputs: { server: true, 'runtime-required': true } }), false);
  assert.equal(condition(resources.if, changeScope(null), { inputs: { server: false, 'runtime-required': true } }), true);
  assert.equal(condition(resources.if, changeScope(null), { inputs: { server: false, 'runtime-required': false } }), false);
  const general = integration.steps.find(step => step.name === 'Run server engine integration tests');
  assert.equal(general.env.LEGALWORK_TEST_WORKERS, '4');
  assert.equal(integration.env.LEGALWORK_TEST_WORKERS, '2');
  assert.equal(condition(main.jobs['sandbox-validation-win32-arm64'].if, changeScope(null), { guest: 'success' }), true);
  assert.equal(condition(main.jobs['sandbox-validation-win32-arm64'].if, changeScope(null), { guest: 'failure' }), false);
  assert.equal(condition(main.jobs['sandbox-validation-win32-arm64'].if, changeScope(null), { sandbox: 'success', event: 'workflow_dispatch' }), true);
});

test('Mac Electron tests consume the Linux renderer only after source and output verification', () => {
  const producer = main.jobs['pr-renderer'];
  assert.equal(producer['runs-on'], 'ubuntu-latest');
  assert.ok(producer.steps.some(step => step.run?.includes('portable-assets.mjs seal renderer')));
  const steps = main.jobs['unit-tests'].steps;
  assert.equal(steps.some(step => step.run?.includes('@legalwork/app build')), false);
  const verify = steps.findIndex(step => step.run === 'node scripts/ci/portable-assets.mjs verify renderer');
  const electron = steps.findIndex(step => step.name === 'Verify workflow editing and close/restart decisions in Electron');
  assert.ok(verify >= 0 && verify < electron);
});


test('native archive extraction converts Windows drive paths before invoking GNU tar', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-unpack-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  try {
    writeFileSync(path.join(bin, 'cygpath'), '#!/bin/sh\nprintf "/d/runner temp/sandbox-runtime/sandbox-runtime.tgz"', { mode: 0o755 });
    writeFileSync(path.join(bin, 'tar'), `#!/bin/sh
case "$2" in *:*) exit 90;; esac
printf '%s' "$2" > "$ARCHIVE_TRACE"
`, { mode: 0o755 });
    const script = workflow('ci-sandbox-validation').jobs.tests.steps.find(step => step.name === 'Unpack exact same-run runtime').run;
    for (const [os, directory, expected] of [['Windows', 'D:\\runner temp', '/d/runner temp/sandbox-runtime/sandbox-runtime.tgz'], ['Linux', root, root + '/sandbox-runtime/sandbox-runtime.tgz']]) {
      const trace = path.join(root, 'archive');
      execFileSync('bash', ['-e', '-c', script], { cwd: root, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RUNNER_OS: os, RUNNER_TEMP: directory, ARCHIVE_TRACE: trace } });
      assert.equal(readFileSync(trace, 'utf8'), expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
