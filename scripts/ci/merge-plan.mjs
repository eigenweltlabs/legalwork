import path from 'node:path';
// Pull request and merge group checks. Release and manual acceptance workflows
// have separate inputs and must never inherit these reduced test selections.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changeScope } from './change-scope.mjs';
import { changedPaths } from './sandbox-changes.mjs';
import { engineTestFiles } from './run-engine-tests.mjs';

const platforms = ['linux', 'darwin', 'win32'];
const engineImplementation = /^(?:packages\/opencode-release\/|(?:docs\/)?patches\/[^/]*opencode|scripts\/ci\/(?:[^/]*(?:opencode|mac-engine|engine-reuse|engine-tests|production-engine)[^/]*)|\.github\/(?:workflows\/ci-(?:opencode|engine-tests)|actions\/setup-opencode\/)|apps\/server\/src\/(?:managed-opencode|engine-client|opencode-(?:connection|engine|proxy|client))(?:[./-]|$))/;
const sandboxShared = /^(?:scripts\/sandbox\/|apps\/server\/resources\/agent-sandbox\/|\.github\/(?:workflows\/(?:ci-sandbox-validation|ci-prepare-engine-runtime|sandbox-runtime)|actions\/(?:prepare|build|test)-sandbox-runtime\/)|scripts\/ci\/(?:run-sandbox|sandbox-test|cache-sandbox|recover-sandbox|extract-runtime)|apps\/server\/src\/agent-sandbox\/(?:vm|host|protocol|filesystem|paths|permissions|network|engine-policy|integrity|acceleration|runtime|proxy-gate)(?:[./-]|$))/;
const packageInput = /(?:^|\/)package\.json$|^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|constants\.json)$/;
const engineDependency = /@opencode\/|@legalwork\/opencode-release|opencode-ai|^[-+]\s*"(?:opencodeVersion|opencodeCommit)"|(?:bun|effect)@\d|^[-+]\s*"(?:effect|bun|@effect\/[^"]+)":/;
const nativeTests = /^(?:apps\/server\/src\/(?:agent-sandbox|calculations)\/|scripts\/sandbox\/)/;
const windowsFile = /windows|win32|\.ps1$|mingw|^scripts\/sandbox\/pe-imports/;
const macFile = /macos|darwin|entitlements\.plist$/;
const linuxFile = /linux/;

export function mergePlan(files, { engineDepsChanged = true, realTests = [] } = {}) {
  const knownWorkspace = /^(?:apps\/(?:app|server|desktop|orchestrator)|packages\/(?:actaport-mcp|legalwork-ui-mcp|openui|types|ui|opencode-release))\//;
  const fallback = files === null || files.some(file => /^(?:apps|packages)\//.test(file) && !knownWorkspace.test(file));
  const paths = files ?? [];
  const fullEngine = fallback || paths.some(file => !file.endsWith('.md') && (engineImplementation.test(file)
    || packageInput.test(file) && engineDepsChanged));
  const targets = new Set(fallback ? platforms : fullEngine ? ['linux'] : []);
  const focused = new Set();
  for (const file of paths) {
    if (file.endsWith('.md')) continue;
    // The application owns admission and permissions even when the VM image
    // itself is unchanged. Keep one real transport exercising that interface.
    if (/^apps\/server\/src\/(?:skill-package\.native\.test|global-tool-permissions|org-policy[^/]*|opencode-plugins\/legalwork-org-policy-guard)\.ts$/.test(file)
      || /^apps\/desktop\/(?:electron\/runtime\.mjs|scripts\/prepare-sidecar\.mjs)$/.test(file)) targets.add('linux');
    if (file.startsWith('.github/actions/setup-merge-engine/')) {
      for (const fixture of realTests.filter(test => test.endsWith('/engine-client.released.test.ts'))) focused.add(fixture);
    }
    if (sandboxShared.test(file)) {
      const platform = windowsFile.test(file) ? 'win32' : macFile.test(file) ? 'darwin' : linuxFile.test(file) ? 'linux' : null;
      for (const target of platform ? [platform] : platforms) targets.add(target);
    } else if (nativeTests.test(file) || /\/legalwork-sandbox(?:\.|-)|\/routes\/agent-sandbox\./.test(file)) {
      targets.add('linux');
    }
    for (const test of realTests) {
      // Test files normally share a stem with their implementation. Keep
      // directly changed fixtures and existing integration tests for the plugin.
      const stem = test.replace(/(?:\.(?:e2e|integration|released|native))?\.test\.ts$/, '');
      if (file === test || file === stem + '.ts') focused.add(test);
    }
  }
  return { fullEngine, targets: platforms.filter(target => targets.has(target)), focused: [...focused].sort() };
}

export function portableAreas(files) {
  const areas = new Set();
  const add = (...items) => items.forEach(item => areas.add(item));
  for (const file of files) {
    if (file.endsWith('.md') || file === 'apps/server/src/core-skills.ts'
      || file.startsWith('docs/user-guide/')) continue;
    if (file.startsWith('packages/openui/')) add('openui');
    if (file.startsWith('apps/app/') || file.startsWith('packages/ui/') || file.startsWith('packages/openui/')) add('app');
    else if (file.startsWith('apps/server/')) add('server');
    else if (file.startsWith('apps/desktop/') || file.startsWith('packages/actaport-mcp/')) add('desktop');
    else if (file.startsWith('apps/orchestrator/')) add('orchestrator');
    else if (file.startsWith('packages/types/')) add('app', 'server', 'desktop');
    else if (file.startsWith('scripts/') || file.startsWith('.github/') || file.startsWith('packages/opencode-release/')) add('tooling');
    else if (Object.values(changeScope([file])).every(Boolean)) add('app', 'server', 'desktop', 'orchestrator', 'tooling');
  }
  return [...areas].sort();
}

export function mergeDiff(env = process.env) {
  const base = env.BASE_SHA, head = env.HEAD_SHA;
  const pr = env.EVENT_NAME === 'pull_request';
  const files = changedPaths(base ?? '', head ?? '', pr);
  if (files === null) throw new Error('Cannot resolve merge candidate SHAs');
  // Only inspect added/removed lines in manifests, without context from unrelated packages.
  const manifests = files.filter(file => packageInput.test(file));
  const delta = manifests.length ? execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--unified=0',
    pr ? base + '...' + head : base + '..' + head, '--', ...manifests], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) : '';
  return { files, engineDepsChanged: delta.split('\n').some(line => /^[-+][^-+]/.test(line) && engineDependency.test(line)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, engineDepsChanged } = mergeDiff();
  const realTests = engineTestFiles(path.resolve('apps/server/src')).map(test => path.relative(process.cwd(), test));
  const plan = mergePlan(files, { engineDepsChanged, realTests });
  const has = pattern => files.some(file => pattern.test(file));
  const native = plan.fullEngine || plan.targets.some(target => target !== 'win32') || plan.focused.length > 0;
  const linuxArm = plan.targets.length === 3 || has(/linux[-_/]arm64|aarch64-linux/);
  const encodedFiles = JSON.stringify(files);
  const result = {
    changed_files: Buffer.byteLength(encodedFiles, 'utf8') <= 32768 ? encodedFiles : 'null',
    direct_linux: !plan.fullEngine && !linuxArm && plan.targets.length === 1 && plan.targets[0] === 'linux',
    linux_arm: linuxArm,
    docx: has(/(?:apps\/app\/.*(?:docx|word-addin)|scripts\/docx|\.github\/workflows\/ci-docx|patches\/[^/]*docx)/),
    docs: has(/^(?:docs\/user-guide\/|scripts\/(?:gen-core-skills|help-)|apps\/server\/(?:src\/core-skills\.ts|resources\/core-opencode\/))/),
    areas: JSON.stringify(portableAreas(files)), full_engine: plan.fullEngine, engine: native, sandbox: plan.targets.length > 0, targets: JSON.stringify(plan.targets),
    focused: JSON.stringify(plan.focused),
    renderer: has(/(?:apps\/desktop\/(?:electron|scripts)\/(?:browser-|preview-security|unsaved-|workflow-editor|shutdown|updater-quit)|apps\/app\/.*(?:unsaved-change|workflow-editor|browser-autofill))/),
    windows_drafts: has(/(?:apps\/server\/src\/(?:email-drafts|calendar-event-drafts)\/|apps\/desktop\/.*(?:outlook|mail-draft|support-bundle|windows-update)|scripts\/test-drafts|scripts\/release\/windows-signing)/),
    windows_meetings: has(/^apps\/desktop\/.*(?:meeting|recorder|capture-helper)/),
  };
  for (const [name, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Merge checks\n\n' + Object.entries(result).filter(([k]) => k !== 'changed_files').map(([k,v]) => '- ' + k + ': ' + v).join('\n') + '\n');
}
