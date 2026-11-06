import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { changeScope, eventScope, scopeNames } from './change-scope.mjs';

test('documentation, isolated UI MCP and presentation changes avoid unrelated builds', () => {
  assert.ok(Object.values(changeScope(['README.md', 'docs/architecture.md'])).every(value => !value));
  assert.deepEqual(Object.entries(changeScope(['packages/legalwork-ui-mcp/index.mjs'])).filter(([, run]) => run).map(([name]) => name), ['ui_mcp']);
  for (const file of ['apps/app/src/components/ui/button.tsx', 'apps/app/src/i18n/locales/de.ts', 'apps/app/src/style.css']) {
    const scope = changeScope([file]);
    assert.equal(scope.app, true); assert.equal(scope.alpha, true);
    for (const key of ['server', 'desktop', 'engine', 'sandbox', 'windows_meetings', 'windows_drafts']) assert.equal(scope[key], false, `${file}: ${key}`);
  }
  const help = changeScope(['docs/user-guide/chat.md']);
  assert.equal(help.docs, true); assert.equal(help.alpha, true); assert.equal(help.engine, false);
});

test('real consumer and platform dependencies retain their checks', () => {
  assert.equal(changeScope(['apps/app/src/react-app/domains/session/send.ts']).engine, true);
  assert.equal(changeScope(['apps/app/scripts/_util.mjs']).engine, true);
  const docx = changeScope(['apps/app/src/react-app/domains/session/artifacts/docx-export.ts']);
  assert.equal(docx.docx, true); assert.equal(docx.app, true);
  assert.equal(changeScope(['apps/app/src/react-app/email-draft.tsx']).windows_drafts, true);
  assert.equal(changeScope(['apps/desktop/electron/meeting-monitor.mjs']).windows_meetings, true);
  assert.equal(changeScope(['apps/desktop/electron/mail-draft.mjs']).windows_drafts, true);
  const calendar = changeScope(['apps/server/src/calendar/service.ts']);
  assert.equal(calendar.server, true); assert.equal(calendar.engine, true); assert.equal(calendar.sandbox, false);
  for (const file of ['apps/server/src/approvals.ts', 'apps/server/src/agent-sandbox/filesystem.ts', 'apps/desktop/electron/runtime.mjs', 'packages/opencode-release/build/recipe.json']) {
    const scope = changeScope([file]);
    for (const key of ['engine', 'sandbox']) assert.equal(scope[key], true, `${file}: ${key}`);
  }
});

test('unknown/shared inputs run all checks; manual and tag invocations cannot be path-filtered', () => {
  for (const paths of [null, ['pnpm-lock.yaml'], ['packages/types/src/index.ts'], ['apps/new-component/main.ts'], ['patches/dep.patch']]) {
    assert.ok(Object.values(changeScope(paths)).every(Boolean));
  }
  for (const env of [{ EVENT_NAME: 'workflow_dispatch' }, { EVENT_NAME: 'push', GIT_REF: 'refs/tags/v1.0.0' }, { EVENT_NAME: 'pull_request', BASE_SHA: 'bad' }]) {
    assert.ok(Object.values(eventScope(env)).every(Boolean));
  }
});

test('filter changes run tooling and workflow changes exercise the relevant entrypoint', () => {
  const scope = changeScope(['scripts/ci/change-scope.mjs']);
  assert.equal(scope.tooling, true); assert.equal(scope.units, true); assert.equal(scope.engine, false);
  assert.equal(changeScope(['.github/workflows/ci-docx.yml']).docx, true);
  assert.equal(changeScope(['.github/workflows/ci-tests.yml']).sandbox, true);
  assert.equal(changeScope(['.github/workflows/alpha-macos-aarch64.yml']).alpha, true);
});

test('selection covers the whole PR/push and includes deleted and renamed dependencies', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ci-scope-git-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const inspect = (base, head, event = 'pull_request') => {
    const output = path.join(cwd, 'output'); writeFileSync(output, '');
    execFileSync(process.execPath, [fileURLToPath(new URL('./change-scope.mjs', import.meta.url))], { cwd,
      env: { ...process.env, EVENT_NAME: event, BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' } });
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
  };
  try {
    git('init', '-b', 'dev'); mkdirSync(path.join(cwd, 'apps/server/src'), { recursive: true });
    writeFileSync(path.join(cwd, 'apps/server/src/approvals.ts'), 'initial');
    writeFileSync(path.join(cwd, 'README.md'), 'initial'); git('add', '.'); git('commit', '-m', 'initial');
    const base = git('rev-parse', 'HEAD'); git('checkout', '-b', 'feature');
    git('mv', 'apps/server/src/approvals.ts', 'README.txt'); git('commit', '-m', 'remove runtime input');
    writeFileSync(path.join(cwd, 'README.md'), 'later docs'); git('add', 'README.md'); git('commit', '-m', 'docs');
    const head = git('rev-parse', 'HEAD');
    assert.equal(inspect(base, head).sandbox, 'true'); assert.equal(inspect(base, head, 'push').sandbox, 'true');
    git('checkout', 'dev'); writeFileSync(path.join(cwd, 'apps/server/src/new.ts'), 'unrelated base change');
    git('add', 'apps'); git('commit', '-m', 'base advance');
    assert.equal(inspect(git('rev-parse', 'HEAD'), head).sandbox, 'true');
    assert.deepEqual(Object.keys(inspect(base, head)).sort(), [...scopeNames].sort());
    assert.ok(Object.values(inspect('a'.repeat(40), head)).every(value => value === 'true'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
