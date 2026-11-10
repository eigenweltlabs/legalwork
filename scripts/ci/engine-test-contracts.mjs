// Native tests cover contracts with the engine, not every module loaded by a
// server fixture. Portable selection still follows the complete import graph.
// Add an owned input here when a native contract gains a dependency. Keep
// ordinary application routes, calendar views and type barrels in portable CI.
import { isTestFile } from './test-dependencies.mjs';
const source = names => new RegExp(`^apps/server/src/(?:${names})(?:\\.[cm]?[jt]s|/|$)`);
const fixtures = names => new RegExp(`^apps/server/src/(?:${names})(?:\\.[a-z0-9-]+)*\\.test\\.[cm]?[jt]s$`);
export const engineTestContracts = [
  { name: 'configuration publication and reload',
    inputs: source('legalwork-runtime-config|runtime-opencode-config-store|runtime-config-(?:upgrade|source-backup)|native-config-state|managed-config-sources|managed-engine-settings|generated-config-file|connected-project-config|capability-library|managed-(?:global|core)-library|native-project-plugins|native-plugin-assets|reload-(?:watcher|fingerprint)|events|plugin-(?:create|import[^/]*|imports)'),
    tests: fixtures('managed-config|managed-engine-settings|managed-engine-lifecycle|managed-engine-catalog-reload|managed-model-filters|native-workspace-config|native-provider-edit|plugin-create-refresh') },
  { name: 'MCP configuration, OAuth and credentials',
    shared: ['connector-config'],
    inputs: source('mcp(?:[.-][^/]*)?|native-mcp-config|connector-(?:config(?:-[^/]*)?|imports)|workspace-mcp-recovery|legacy-mcp-(?:credentials|lifecycle)|routes/mcp[^/]*'),
    tests: fixtures('mcp(?:[.-][^/]*)?|legacy-mcp-(?:credentials|lifecycle)|managed-engine-lifecycle') },
  { name: 'native configuration schema', inputs: source('native-opencode-config'),
    tests: fixtures('mcp(?:[.-][^/]*)?|scheduled-tasks/engine|managed-config') },
  { name: 'native agent definitions', inputs: source('native-agent-(?:definitions|schema)|opencode-plugins/managed-native-agents'),
    tests: fixtures('shared-core|managed-config|native-model-requests|assistant-engine|assistant-proactivity') },
  { name: 'provider credentials and migration',
    inputs: source('legacy-provider-credentials|voice-native-credentials|routes/engine-credentials'),
    tests: fixtures('legacy-provider-credentials|voice-native-credentials|managed-engine-lifecycle|engine-storage|native-proxy') },
  { name: 'model catalog and providers',
    shared: ['native-model-display', 'model-limits', 'provider-usage-limit'],
    inputs: source('model-(?:catalog|limits)|provider-model-(?:catalog|discovery)|custom-provider-model-refresh|azure-model-definitions|native-model-catalog-rpc|native-provider-(?:display|edit)|provider-selection|opencode-model-config|runtime-provider-repair|org-policy-ai|opencode-plugins/legalwork-model-catalog'),
    tests: fixtures('azure-model-definitions|model-catalog-engine|native-model-(?:catalog|requests)|native-provider-(?:display|edit)|provider-selection|managed-model-filters|managed-engine-catalog-reload') },
  { name: 'permissions and organization policy',
    shared: ['org-policy', 'org-policy-view'],
    inputs: source('global-tool-permissions|native-(?:permission-edit|folder-approval|proxy-policy|saved-approval-migration)|project-permission-approvals|org-policy(?:-[^/]*)?|project-storage-permissions|session-history-permissions|approvals|tokens|routes/registry|opencode-plugins/(?:legalwork-org-policy-guard|managed-folder-permissions)'),
    tests: fixtures('native-(?:global-policy-precedence|host-execution-policy|file-permissions|folder-approval|saved-approval-migration|secret-boundary|worktree-boundary|proxy)|managed-file-permissions|org-policy-engine|session-history-permissions|managed-engine-settings.policy') },
  { name: 'project storage and recovery',
    shared: ['engine-project'],
    inputs: source('engine-project|engine-storage|native-engine-(?:project-registry|recovery)|project-engine-registration|managed-image-affinity|project-storage(?:-[^/]*)?|project-availability|workspace-files|native-project-(?:admission|move)|native-vcs|routes/engine-project'),
    tests: fixtures('managed-engine-lifecycle|native-project-(?:admission|move)|project-storage|engine-storage|native-worktree-boundary|native-workspace-config|native-vcs-init|managed-config') },
  { name: 'session history and native delivery',
    shared: ['session-history', 'session-visibility', 'session-queue'],
    inputs: source('session-(?:read-model[^/]*|history[^/]*|visibility|inbox)|history-(?:migration|undo|images|provenance|v1-backup)|content-search|opencode-db|native-(?:command[^/]*|queue[^/]*|delivery|proxy-events)'),
    tests: fixtures('history-(?:migration|undo)|session-(?:read-models|history-permissions)|native-passive-events|native-proxy|opencode-plugins/(?:legalwork-history-image-tools|legalwork-sandbox)|reviews/engine|scheduled-tasks/engine') },
  { name: 'shared libraries and plugin registration',
    inputs: source('shared-core|core-bundle|managed-core-(?:library|skills)|managed-global-library|skills|skill-package|skill-resources|workspace-init|legalwork-extensions-plugin-path|extensions|opencode-plugins/legalwork-(?:extensions[^/]*|draft-tools)'),
    tests: fixtures('shared-core|opencode-plugins/legalwork-skill-resources|plugin-create-refresh') },
  { name: 'storage tools and native PDF reading',
    inputs: source('opencode-plugins/legalwork-storage-tools|pdf-reader|pdf-read-schema|document-preparation/render|ocr/service'),
    tests: fixtures('opencode-plugins/pdf-reading') },
  { name: 'native plugin protocol',
    inputs: source('opencode-plugins/(?:native-tool|native-chat-tool-results|native-events|native-context|native-review-worker|native-provider-request|native-plugin-build[^/]*|native-plugin-assets)'),
    tests: fixtures('opencode-plugins/[^/]+') },
  { name: 'built-in plugin startup', inputs: source('opencode-plugins/[^/]+'),
    tests: fixtures('shared-core') },
  { name: 'browser requests and tool recovery', inputs: source('opencode-plugins/(?:browser-password-request|legalwork-tool-recovery)'),
    tests: fixtures('opencode-plugins/(?:assistant-browser|legalwork-tool-output)') },
  { name: 'individual native plugin behavior', sameStem: true,
    inputs: source('opencode-plugins/(?:assistant[^/]*|legalwork-(?:digest-tools|raw-http|tool-image-originals|tool-output|skill-resources|history-image-tools)|native-(?:office|codemode)-host)'),
    tests: fixtures('opencode-plugins/(?:assistant[^/]*|legalwork-(?:digest-tools|raw-http|tool-image-originals|tool-output|skill-resources|history-image-tools)|native-(?:office|codemode)-host)') },
  { name: 'native digest and original images', inputs: source('content-digest|tool-image-original-(?:schema|store)'),
    tests: fixtures('opencode-plugins/legalwork-(?:digest-tools|tool-image-originals)') },
  { name: 'assistant behavior, reviews and scheduling',
    inputs: source('assistant-(?:engine|browser|proactivity(?:-store)?|reaction|language-context|session-access|session-executor)|proactivity|reviews|scheduled-tasks|task-store|project-contents|legalmemory(?:-[^/]*)?'),
    tests: fixtures('assistant-engine|assistant-proactivity|opencode-plugins/assistant-(?:browser|reaction)|reviews/engine|scheduled-tasks/engine|legalmemory-native') },
  { name: 'engine process, transport and compiled distribution',
    inputs: source('managed-opencode[^/]*|engine-client|opencode-(?:connection|engine|proxy|client|mac-signing)|compiled-managed-server|native-(?:proxy|shared-values)'),
    tests: fixtures('managed-opencode[^/]*|engine-client|compiled-managed-server|opencode-mac-signing|native-proxy') },
  { name: 'sandbox contract', inputs: source('agent-sandbox|opencode-plugins/legalwork-sandbox'),
    tests: fixtures('agent-sandbox/engine|opencode-plugins/legalwork-sandbox') },
  { name: 'shared configuration persistence',
    inputs: source('file-write-lock|canonical-path|runtime-db|runtime-config-migrate'),
    tests: fixtures('managed-config|managed-engine-lifecycle|native-workspace-config|engine-storage|history-migration|legacy-(?:mcp|provider)-credentials|native-saved-approval-migration') },
];

export function contractTests(inputs, tests, contracts = engineTestContracts) {
  const result = new Set(inputs.filter(file => tests.includes(file)));
  const implementations = inputs.filter(file=>!isTestFile(file));
  for (const contract of contracts) {
    if (contract.sameStem) continue;
    if (!implementations.some(file => contract.inputs.test(file)
      || contract.shared?.some(name=>file===`packages/types/src/${name}.ts`))) continue;
    for (const test of tests) if (contract.tests.test(test)) result.add(test);
  }
  // A plugin's own fixture is more precise than all other plugin fixtures.
  for (const input of inputs) for (const test of tests) {
    const implementation = test.replace(/(?:\.(?:e2e|integration|released|native))?\.test\.[cm]?[jt]s$/, '.ts');
    if (input === implementation) result.add(test);
  }
  return [...result].sort();
}
