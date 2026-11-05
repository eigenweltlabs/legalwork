// One dependency map for automatic CI. Unknown inputs fail open to all checks.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changedPaths, needsSandboxRuntime } from './sandbox-changes.mjs';

export const scopeNames = ['app', 'server', 'desktop', 'tooling', 'docs', 'engine', 'sandbox',
  'windows_meetings', 'windows_drafts', 'docx', 'i18n', 'ui_mcp', 'alpha', 'units'];

export function changeScope(paths) {
  const scope = Object.fromEntries(scopeNames.map(name => [name, false]));
  const enable = (...names) => names.forEach(name => { scope[name] = true; });
  if (paths === null) return Object.fromEntries(scopeNames.map(name => [name, true]));
  for (const file of paths) {
    if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|constants\.json|\.npmrc)$/.test(file)
      || /^(patches\/|packages\/(?!legalwork-ui-mcp\/|opencode-release\/))/.test(file)) {
      return changeScope(null);
    }
    if (file.startsWith('apps/app/')) {
      enable('app', 'docs', 'alpha');
      // Pure presentation edits do not affect the native engine contract.
      if (!/^apps\/app\/(?:src\/(?:components\/ui\/|i18n\/locales\/)|public\/)/.test(file)
        && !/\.(css|svg|png|jpg|woff2?)$/.test(file)) enable('engine');
      if (file.startsWith('apps/app/src/')) enable('i18n');
      if (/desktop|electron|ipc|bridge/.test(file)) enable('desktop', 'windows_drafts');
      if (/docx|\/artifacts\/|\/fixtures\//.test(file)) enable('docx');
      if (/draft|mail|calendar/.test(file)) enable('windows_drafts');
      continue;
    }
    if (file.startsWith('apps/server/')) {
      enable('server', 'desktop', 'windows_drafts', 'alpha');
      if (/core-skills|\/skills\//.test(file)) enable('docs');
      continue;
    }
    if (file.startsWith('apps/desktop/')) {
      enable('desktop', 'windows_drafts', 'alpha');
      if (/meeting|windows-|package\.json/.test(file)) enable('windows_meetings');
      continue;
    }
    if (file.startsWith('packages/opencode-release/')) {
      enable('server', 'desktop', 'tooling', 'sandbox', 'alpha');
      continue;
    }
    if (file.startsWith('packages/legalwork-ui-mcp/')) { enable('ui_mcp'); continue; }
    if (/^docs\/user-guide\//.test(file) || /^scripts\/gen-core-skills/.test(file)) {
      enable('docs', 'alpha'); continue;
    }
    if (/^scripts\/help-/.test(file)) { enable('docs', 'tooling', 'alpha'); continue; }
    if (/^scripts\/i18n/.test(file)) { enable('i18n', 'tooling'); continue; }
    if (/^scripts\/(ci|release)\//.test(file)) {
      enable('tooling');
      if (/^scripts\/ci\/(build-opencode|reuse-opencode|cache-opencode|mac-engine)/.test(file)) enable('engine');
      continue;
    }
    if (/^scripts\/sandbox\//.test(file)) { enable('server', 'desktop', 'sandbox', 'alpha'); continue; }
    if (/^scripts\//.test(file)) { enable('app', 'server', 'desktop', 'tooling', 'alpha'); continue; }
    if (file.startsWith('.github/')) {
      enable('tooling');
      if (/ci-i18n\.yml$/.test(file)) enable('i18n');
      if (/ci-docx\.yml$/.test(file)) enable('docx');
      if (/ci-legalwork-ui-mcp\.yml$/.test(file)) enable('ui_mcp');
      if (/alpha-|release-macos/.test(file)) enable('alpha');
      if (/ci-tests|ci-desktop|ci-opencode|ci-windows-opencode|sandbox-runtime|setup-opencode|mac-engine-signing/.test(file)) {
        enable('app', 'server', 'desktop', 'sandbox');
      }
      if (/ci-tests\.yml$/.test(file)) enable('windows_meetings', 'windows_drafts', 'docs');
      continue;
    }
    if (/^(docs\/|\.vscode\/|\.githooks\/)|\.(md|txt)$|^(LICENSE|NOTICE|\.gitignore|\.gitattributes|CODEOWNERS)$/.test(file)) continue;
    // New app/package roots and build configuration need coverage until mapped.
    return changeScope(null);
  }
  if (needsSandboxRuntime(paths)) enable('sandbox');
  if (scope.server || scope.desktop || scope.sandbox) enable('engine');
  scope.units = scope.app || scope.server || scope.desktop || scope.tooling || scope.engine;
  return scope;
}

export function eventScope(env = process.env) {
  if (!['pull_request', 'push'].includes(env.EVENT_NAME) || env.GIT_REF?.startsWith('refs/tags/')) return changeScope(null);
  // Git failures, deleted branches and unknown SHAs must never hide coverage.
  try { return changeScope(changedPaths(env.BASE_SHA ?? '', env.HEAD_SHA ?? '', env.EVENT_NAME === 'pull_request')); }
  catch (error) { console.warn(`Cannot establish changed files; running all checks: ${error.message}`); return changeScope(null); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = eventScope();
  const lines = Object.entries(scope).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Checks selected from changed files\n\n${Object.entries(scope).map(([key, value]) => `- ${key}: ${value ? 'run' : 'unaffected'}`).join('\n')}\n`);
  console.log(lines);
}
