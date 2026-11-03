import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Unit tests always run. Only builds and real-VM tests use this filter.
// Electron's UI entrypoint and package scripts are covered by desktop tests;
// dependency changes are covered by pnpm-lock.yaml. CI filter edits need only
// the filter tests, not a rebuild of the runtime they select.
export function needsSandboxRuntime(paths) {
  return paths.some(path => /^(?:scripts\/sandbox\/|apps\/server\/(?:resources\/agent-sandbox\/|src\/(?:agent-sandbox|calculations)\/)|\.github\/actions\/(?:setup-opencode|build-sandbox-runtime|test-sandbox-runtime)\/)/.test(path)
    || /^\.github\/workflows\/(?:ci-tests|sandbox-runtime|ci-desktop-packaging)\.yml$/.test(path)
    || /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|constants\.json)$/.test(path)
    || path === 'apps/server/package.json'
    || /^apps\/server\/src\/routes\/agent-sandbox(?:\.[^/]+)?\.ts$/.test(path)
    || /^apps\/desktop\/(?:electron\/runtime\.mjs|scripts\/prepare-sidecar\.mjs|electron-builder[^/]*)$/.test(path)
    || /^apps\/server\/src\/(?:server|auth|config|approvals|global-tool-permissions|runtime-opencode-config-store|legalwork-runtime-config|org-policy[^/]*|opencode-proxy[^/]*|opencode-connection|opencode-engine[^/]*|engine[^/]*|types|workspace-files|skills|skill-[^/]*)\.[cm]?ts$/.test(path)
    || /^apps\/server\/src\/opencode-plugins\/(?:legalwork-sandbox|legalwork-skill-[^/]*|legalwork-org-policy-guard|office-plugin-shared|app-state-reminders)(?:\.[^/]+)?\.ts$/.test(path)
    || /^apps\/server\/(?:scripts\/gen-web-worker-code\.ts|test-preload\.ts|bunfig\.toml|tsconfig\.json)$/.test(path));
}

export function changedPaths(base, head, pullRequest) {
  if (!/^[a-f0-9]{40}$/.test(base) || /^0+$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) return null;
  // NUL-separated paths include deletions and both sides of renames. Compare
  // PR changes from the merge base; pushes include every commit in the push.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', pullRequest ? `${base}...${head}` : base, ...(pullRequest ? [] : [head])], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { EVENT_NAME, BASE_SHA, HEAD_SHA, GITHUB_OUTPUT } = process.env;
  const paths = EVENT_NAME === 'workflow_dispatch' ? null : changedPaths(BASE_SHA ?? '', HEAD_SHA ?? '', EVENT_NAME === 'pull_request');
  const required = paths === null || needsSandboxRuntime(paths);
  console.log(`Sandbox runtime validation: ${required ? 'required' : 'unchanged; unit tests still run'}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `required=${required}\n`);
}
