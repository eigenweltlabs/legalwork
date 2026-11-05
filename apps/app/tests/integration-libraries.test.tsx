import { expect, test } from "bun:test";
import { Plus, Search } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { storageInputSchema } from "@legalwork/types/file-storage";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { SkillsView, type SkillsExtensionsStore } from "../src/react-app/domains/settings/pages/skills-view";
import { BuiltInSkills, ImportedPackageContents, ImportedPackages } from "../src/react-app/domains/settings/pages/skill-packages";
import type { ImportedPlugin } from "../src/app/lib/extension-imports";
import { pluginFileInstalledName } from "../src/react-app/domains/settings/pages/plugin-package-contents";
import { FileStorageView } from "../src/react-app/domains/settings/pages/file-storage-view";
import { HubScopeContext } from "../src/react-app/domains/settings/pages/hub-scope-context";
import { IntegrationAddMenu, IntegrationLibraryLayoutContext, IntegrationLibrarySearchContext, type IntegrationLibrarySource } from "../src/react-app/domains/settings/pages/integration-library";
import { HubDownloadSection } from "../src/react-app/domains/settings/pages/hub-download-section";
import { FIRM_HUB_QUERY_KEY } from "../src/react-app/domains/connections/firm-hub";
import { eigenweltEntitlementsQueryKey } from "../src/react-app/domains/connections/eigenwelt-entitlements";
import type { ConnectorState } from "../src/react-app/domains/settings/pages/connector-status";
import { WorkflowsView } from "../src/react-app/domains/settings/pages/workflows-view";
import { ReviewPromptLibrary } from "../src/react-app/domains/reviews/review-prompt-library";
import { ReviewLibraryEntrySchema } from "@legalwork/types/reviews";

const noop = () => {};
const ok = async () => ({ ok: true, message: "" });
const unused = async (): Promise<never> => { throw new Error("Must not execute during rendering"); };

test("a single Add action is a direct button; alternate creation paths use a menu", () => {
  const add = { label: "New skill", icon: Plus, onClick: noop };
  const single = renderToStaticMarkup(<IntegrationAddMenu actions={[add]} />);
  expect(single).toContain('title="New skill"');
  expect(single).not.toContain('aria-haspopup="menu"');
  expect(single).not.toContain("lucide-chevron-down");
  const multiple = renderToStaticMarkup(<IntegrationAddMenu actions={[{ label: "Browse directory", icon: Search, onClick: noop }, add]} />);
  expect(multiple).toContain('aria-haspopup="menu"');
  expect(multiple).toContain("lucide-chevron-down");
});
const skills = Array.from({ length: 13 }, (_, index) => ({ name: `skill-${index + 1}`, path: `/skills/skill-${index + 1}`, description: `Skill number ${index + 1}` }));
const extensions: SkillsExtensionsStore = {
  skills: () => skills, skillsStatus: () => null, hubSkills: () => [], hubSkillsStatus: () => null, hubRepo: () => null, hubRepos: () => [],
  ensureHubSkillsFresh: noop, refreshSkills: noop, refreshHubSkills: noop, setHubRepo: noop, addHubRepo: noop, removeHubRepo: noop,
  installSkillCreator: ok, installHubSkill: ok, importLocalSkill: noop, importLocalSkillZip: noop, scanGithubSkills: unused, importGithubSkills: ok,
  revealSkillsFolder: noop, readSkill: async () => null, saveSkill: noop, createSkill: ok, uninstallSkill: noop, exportSkillZip: ok,
  importedPackages: async () => [], removeImportedPackage: async () => {}, previewClaudePlugin: unused, installClaudePlugin: ok, readFirmSkill: unused,
  skillResources: () => [], skillResourcesStatus: () => null, refreshSkillResources: noop, readSkillResource: async () => null, saveSkillResource: ok, deleteSkillResource: ok,
};

function renderSkills(kind: "skills" | "workflows" = "skills") {
  return renderToStaticMarkup(<SkillsView workspaceName="Test" busy={false} showHeader={false} canInstallSkillCreator canUseDesktopTools extensions={extensions} onOpenLink={noop} createSessionAndOpen={noop} kind={kind} />);
}

test("ordinary skills expose the full library beyond the workflow page size", () => {
  const html = renderSkills();
  for (const skill of skills) expect(html).toContain(`>${skill.name}<`);
  expect(html).toContain('aria-label="Actions for skill-13"');
  expect(html).not.toContain("Page 1 /");
});

test("skills stay separate from workflows and include built-in expertise", () => {
  expect(renderSkills()).toContain("DOCX Redline");
  expect(renderSkills()).toContain("PDF Tools");
  const workflowHtml = renderSkills("workflows");
  expect(workflowHtml).not.toContain("DOCX Redline");
  expect(workflowHtml).not.toContain(">skill-13<");
});

test("built-in search includes commands and omits unrelated entries", () => {
  const html = renderToStaticMarkup(<BuiltInSkills searchQuery="/fill-form" />);
  expect(html).toContain("PDF Tools");
  expect(html).not.toContain("DOCX Redline");
  expect(renderToStaticMarkup(<BuiltInSkills searchQuery="no-match" showEmpty />)).toContain("No matching skills");
});

test("plugin skills stay in the Skills library and package details list their actual components", () => {
  const plugin: ImportedPlugin = { pluginId: "patent", marketplaceId: null, name: "patent-studio", displayName: "Patent Studio", description: null, updatedAt: null, importedAt: 1, files: [
    { configObjectId: "review", versionId: null, objectType: "skill", title: "Claim Review", path: ".opencode/skills/patent-studio-plugin/claim-review/SKILL.md", updatedAt: null },
    { configObjectId: "search", versionId: null, objectType: "mcp", title: "Patent Studio", path: "opencode.jsonc#mcp.patent-search", updatedAt: null },
    { configObjectId: "bundle", versionId: null, objectType: "bundle", title: "Complete source package", path: ".opencode/imported-plugins/patent-studio", updatedAt: null },
  ] };
  const html = renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, importedPackages: [plugin] }}><SkillsView workspaceName="Test" busy={false} showHeader={false} canInstallSkillCreator canUseDesktopTools extensions={{ ...extensions, skills: () => [...skills, { name: "claim-review", path: "/global/skills/patent-studio-plugin/claim-review", description: "Review claims" }] }} onOpenLink={noop} createSessionAndOpen={noop} /></IntegrationLibraryLayoutContext.Provider>);
  expect(html.match(/aria-label="Actions for claim-review"/g)).toHaveLength(1);
  expect(html.match(/Plugin: Patent Studio/g)).toHaveLength(1);
  expect(html).toContain("skill-13");
  const contents = renderToStaticMarkup(<ImportedPackageContents plugin={plugin} />);
  expect(contents).toContain("Claim Review");
  expect(contents).toContain("patent-search");
  expect(contents).toContain("1 skill");
  expect(contents).toContain("1 connector");
  expect(contents).not.toContain("Complete source package");
  expect(renderToStaticMarkup(<ImportedPackageContents plugin={{ ...plugin, files: [] }} />)).toContain("Source files only");
});

test("plugin contents display readable names while opening the exact installed component", () => {
  const file = { configObjectId: "clerk", versionId: null, objectType: "skill", title: "app-6a9a3c1cd0108191-11ef2684-clerk-android", path: ".opencode/skills/app-6a9a3c1cd0108191807da33c4cd319ed-11ef2684-plugin/app-6a9a3c1cd0108191-11ef2684-clerk-android/SKILL.md", updatedAt: null };
  const plugin: ImportedPlugin = { pluginId: "clerk", marketplaceId: null, name: "clerk", description: null, updatedAt: null, importedAt: null, files: [file] };
  const html = renderToStaticMarkup(<ImportedPackageContents plugin={plugin} onOpen={noop} skills={[{ name: file.title, path: file.path, description: "Native Android authentication" }]} />);
  expect(html).toContain('aria-label="Open Clerk Android"');
  expect(html).toContain("Native Android authentication");
  expect(html).not.toContain("app-6a9a3c1cd0108191");
  expect(pluginFileInstalledName(file)).toBe(file.title);
  const filtered = renderToStaticMarkup(<ImportedPackageContents plugin={plugin} query="no match" onOpen={noop} />);
  expect(filtered).toContain("No matching items");
  expect(filtered).not.toContain("Open Clerk Android");
  expect(pluginFileInstalledName({ ...file, objectType: "mcp", title: "Plugin owner", path: "opencode.jsonc#mcp.exact-connector-name" })).toBe("exact-connector-name");
});

test("the Plugins library separates bundles from standalone imports while the import manager retains all records", () => {
  const plugin: ImportedPlugin = { sourceKind: "plugin", pluginId: "import:claude:patent:global", marketplaceId: null, name: "patent", displayName: "Patent Studio", description: "Patent research", updatedAt: null, importedAt: 1, files: [] };
  const items: ImportedPlugin[] = [plugin, { ...plugin, sourceKind: "skill", pluginId: "skill", displayName: "Standalone drafting" }, { ...plugin, sourceKind: "connector", pluginId: "connector", displayName: "Standalone search" }, { ...plugin, sourceKind: undefined, pluginId: "legacy", displayName: "Existing package" }];
  const render = (library: boolean, source: IntegrationLibrarySource = "all", searchQuery = "") => renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, source, importedPackages: items }}><ImportedPackages extensions={extensions} busy={false} revision={0} library={library} searchQuery={searchQuery} showEmpty /></IntegrationLibraryLayoutContext.Provider>);
  const all = render(true);
  expect(all).toContain("Patent Studio");
  expect(all).toContain("Existing package");
  expect(all).toContain("Claude");
  expect(all).not.toContain("Standalone drafting");
  expect(all).not.toContain("Standalone search");
  expect(render(true, "personal")).toContain("Patent Studio");
  expect(render(true, "team")).toContain("Team plugins are not available yet.");
  expect(render(true, "team")).not.toContain("Patent Studio");
  expect(render(true, "all", "missing")).toContain("No matching plugins");
  expect(render(false)).toContain("Standalone drafting");
  expect(render(false)).toContain("Standalone search");
});

const connectorPlugin: ImportedPlugin = { sourceKind: "plugin", pluginId: "import:claude:research:global", marketplaceId: null, name: "research", description: "Research tools", updatedAt: null, importedAt: 1, files: [
  { configObjectId: "owned", versionId: null, objectType: "mcp", title: "Research owner", path: "opencode.jsonc#mcp.exact-research", updatedAt: null },
] };
function renderPluginState(states: Record<string, ConnectorState>, plugin = connectorPlugin) {
  return renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, importedPackages: [plugin], connectorState: name => states[name] }}><ImportedPackages extensions={extensions} busy={false} revision={0} library showEmpty /></IntegrationLibraryLayoutContext.Provider>);
}

test("plugin summaries identify affected connectors while component rows retain their exact setup state", () => {
  const cases: { state: ConnectorState; label: string | null }[] = [
    { state: "disabled", label: "Enable to use" }, { state: "needs_auth", label: "Sign in to use it" },
    { state: "needs_key", label: "Add your key to use it" }, { state: "needs_client_registration", label: "Sign-in setup is incomplete" },
    { state: "failed", label: "Issue" }, { state: "disconnected", label: "Offline" }, { state: "connected", label: null },
  ];
  for (const { state, label } of cases) {
    const html = renderPluginState({ "exact-research": state });
    if (label) {
      expect(html).toContain(state === "failed" || state === "disconnected" ? "1 connector needs attention" : "1 connector needs setup");
      const contents = renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, connectorState: () => state }}><ImportedPackageContents plugin={connectorPlugin} onOpen={noop} /></IntegrationLibraryLayoutContext.Provider>);
      expect(contents).toContain(label);
    }
    else {
      expect(html).not.toContain("Enable to use");
      expect(html).not.toContain("Sign in to use it");
      expect(html).not.toContain("Offline");
      expect(html).not.toContain(">Ready<");
    }
  }
});

test("multi-connector plugins count only components needing attention, while skills and unknown states add no warning", () => {
  const plugin: ImportedPlugin = { ...connectorPlugin, files: [...connectorPlugin.files,
    { ...connectorPlugin.files[0], path: "opencode.jsonc#mcp.second", configObjectId: "second" },
    { ...connectorPlugin.files[0], path: ".opencode/skills/research/SKILL.md", objectType: "skill", configObjectId: "skill" },
  ] };
  expect(renderPluginState({ "exact-research": "needs_auth", second: "connected" }, plugin)).toContain("1 connector needs setup");
  expect(renderPluginState({ "exact-research": "disabled", second: "needs_auth" }, plugin)).toContain("2 connectors need setup");
  expect(renderPluginState({ "exact-research": "failed", second: "needs_auth" }, plugin)).toContain("2 connectors need attention");
  expect(renderPluginState({ "exact-research": "connected", second: "connected" }, plugin)).not.toContain("need setup");
  expect(renderPluginState({}, plugin)).not.toContain("needs setup");
  expect(renderPluginState({}, { ...plugin, files: plugin.files.filter(file => file.objectType === "skill") })).not.toContain("Offline");
});

test("plugin contents show setup states beside the exact connector that will open", () => {
  const html = renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, connectorState: name => name === "exact-research" ? "needs_auth" : undefined }}><ImportedPackageContents plugin={connectorPlugin} onOpen={noop} /></IntegrationLibraryLayoutContext.Provider>);
  expect(html).toContain("Sign in to use it");
  expect(html).toContain('aria-label="Open exact-research"');
});

function renderSkillSources(source: IntegrationLibrarySource, query = "") {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const client = createLegalworkServerClient({ baseUrl: "https://example.invalid" });
  const automatic = { id: "automatic", kind: "skill", name: "team-research", description: "Research shared by the team", createdByUserId: "author", version: 1, updatedAt: "2026-10-12" };
  const offered = { ...automatic, id: "offered", name: "offered-review", description: "Optional team review" };
  queries.setQueryData(eigenweltEntitlementsQueryKey(), { entitlements: { features: ["admin_hub"] }, connected: true });
  queries.setQueryData(["eigenwelt-hub", "skill", "test"], [automatic, offered]);
  queries.setQueryData(FIRM_HUB_QUERY_KEY, { connected: true, items: [{ ...automatic, installation: "automatic", added: false }, { ...offered, installation: "optional", added: false }] });
  const teamView = <HubDownloadSection legalworkClient={client} workspaceId="test" kind="skill" readSkill={unused} />;
  const html = renderToStaticMarkup(<QueryClientProvider client={queries}><IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, source }}><IntegrationLibrarySearchContext.Provider value={{ query, hasOtherResults: false }}>
    {query ? teamView : <SkillsView workspaceName="Test" busy={false} showHeader={false} canInstallSkillCreator canUseDesktopTools extensions={{ ...extensions, skills: () => [...skills, { name: automatic.name, path: "/team/research", firm: "automatic" }] }} onOpenLink={noop} createSessionAndOpen={noop} firmDownloadView={teamView} />}
  </IntegrationLibrarySearchContext.Provider></IntegrationLibraryLayoutContext.Provider></QueryClientProvider>);
  queries.clear();
  return html;
}

test("skills source tabs include the full team catalogue once, with optional skills beside installed ones", () => {
  const all = renderSkillSources("all");
  expect(all).toContain("skill-13");
  expect(all).toContain("DOCX Redline");
  expect(all.match(/>Team Research</g)).toHaveLength(1);
  expect(all).toContain("Offered Review");
  const personal = renderSkillSources("personal");
  expect(personal).toContain("skill-13");
  expect(personal).not.toContain("Team Research");
  expect(personal).not.toContain("Offered Review");
  expect(personal).not.toContain("DOCX Redline");
  const team = renderSkillSources("team");
  expect(team).toContain("Team Research");
  expect(team).toContain("Offered Review");
  expect(team).not.toContain("skill-13");
  expect(team).not.toContain("DOCX Redline");
  expect(team).not.toContain("Installed for everyone</");
});

test("embedded team skills use the library search and show an empty result rather than a second browser", () => {
  const match = renderSkillSources("team", "optional");
  expect(match).toContain("Offered Review");
  expect(match).not.toContain("Team Research");
  expect(renderSkillSources("team", "no-match")).toContain("No matching skills");
});

function workflowLibrary(source: IntegrationLibrarySource, query = "", page = false) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const client = createLegalworkServerClient({ baseUrl: "https://example.invalid" });
  const shared = { id: "shared-workflow", kind: "workflow", name: "workflow-assistant-team-review", description: "Review shared by the team", createdByUserId: "author", version: 1, updatedAt: "2026-10-25" };
  queries.setQueryData(eigenweltEntitlementsQueryKey(), { entitlements: { features: ["admin_hub"] }, connected: true });
  queries.setQueryData(["eigenwelt-hub", "workflow", "test"], [shared, { ...shared, id: "optional", name: "workflow-assistant-optional-check", description: "Optional team check" }]);
  queries.setQueryData(FIRM_HUB_QUERY_KEY, { connected: true, items: [{ ...shared, installation: "automatic", added: false }, { ...shared, id: "optional", installation: "optional", added: false }] });
  const team = <HubDownloadSection legalworkClient={client} workspaceId="test" kind="workflow" readSkill={unused} />;
  const store = { ...extensions, workspaceContextKey: () => "test", skills: () => [
    { name: "workflow-assistant-personal-review", path: "/skills/personal-review", description: "Personal document review" },
    { name: shared.name, path: "/firm/shared-review", description: shared.description, firm: "automatic" },
    ...skills,
  ] };
  const html = renderToStaticMarkup(<QueryClientProvider client={queries}>
    {page ? <WorkflowsView workspaceId="test" workspaceName="Test" busy={false} canInstallSkillCreator canUseDesktopTools extensions={store} onOpenLink={noop} createSessionAndOpen={noop} firmDownloadView={team} />
      : <IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, source }}><IntegrationLibrarySearchContext.Provider value={{ query, hasOtherResults: false }}>{team}</IntegrationLibrarySearchContext.Provider></IntegrationLibraryLayoutContext.Provider>}
  </QueryClientProvider>);
  queries.clear();
  return html;
}

test("Workflows defaults to the combined library without duplicate installed team items or the old Local toggle", () => {
  const html = workflowLibrary("all", "", true);
  expect(html).toContain("Personal Review");
  expect(html.match(/>Team Review</g)).toHaveLength(1);
  expect(html).toContain("Optional Check");
  expect(html).not.toContain(">skill-13<");
  expect(html).not.toContain(">Local<");
  expect(html).not.toContain('aria-label="Library scope"');
  expect(html).toContain('title="Library source"');
});

test("team workflows obey the same source and search filters as integration skills", () => {
  expect(workflowLibrary("personal")).not.toContain("Team Review");
  const team = workflowLibrary("team", "optional");
  expect(team).toContain("Optional Check");
  expect(team).not.toContain("Team Review");
  expect(team).not.toContain("Workflows shared by");
  expect(workflowLibrary("team", "nothing matches")).toContain("No workflows match your search.");
});

test("the prompt library follows the page's All, Personal and Team filter", () => {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const client = createLegalworkServerClient({ baseUrl: "https://example.invalid" });
  queries.setQueryData(["review-library", "test", "en"], { entries: ["builtin", "personal", "firm"].map(source => ReviewLibraryEntrySchema.parse({
    id: source, kind: "set", version: 1, name: `${source} review set`, source, language: "en", updatedAt: 1,
    columns: [{ key: "test", label: "Test", question: "Test?", kind: "text" }],
  })) });
  const render = (source: IntegrationLibrarySource) => renderToStaticMarkup(<QueryClientProvider client={queries}><IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, source }}><ReviewPromptLibrary client={client} workspaceId="test" /></IntegrationLibraryLayoutContext.Provider></QueryClientProvider>);
  const all = render("all"), personal = render("personal"), team = render("team");
  for (const name of ["builtin", "personal", "firm"]) expect(all).toContain(`${name} review set`);
  expect(personal).toContain("personal review set");
  expect(personal).not.toContain("firm review set");
  expect(personal).not.toContain("builtin review set");
  expect(team).toContain("firm review set");
  expect(team).not.toContain("personal review set");
  expect(team).not.toContain("builtin review set");
  queries.clear();
});

function renderStorage(team = false, empty = false) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const connection = { ...storageInputSchema.parse({ name: "Office documents", config: { kind: "webdav", endpoint: "https://example.invalid/files" } }), id: "docs", updatedAt: 1, configuredSecrets: [] };
  queries.setQueryData(["storage-connections", "test"], { connections: empty ? [] : [connection] });
  queries.setQueryData(["storage-oauth-providers", "test"], { providers: [] });
  const html = renderToStaticMarkup(<QueryClientProvider client={queries}><HubScopeContext.Provider value={team ? "team" : "local"}><FileStorageView client={createLegalworkServerClient({ baseUrl: "https://example.invalid" })} workspaceId="test" /></HubScopeContext.Provider></QueryClientProvider>);
  queries.clear();
  return html;
}

test("storage leads with connected accounts and keeps the provider catalog out of the library", () => {
  const html = renderStorage();
  expect(html).toContain("Office documents");
  expect(html).toContain("Search storage");
  expect(html).toContain("Your storage");
  expect(html).not.toContain("SFTP");
  expect(html).not.toContain("https://example.invalid/files");
});

test("storage empty and team states preserve scope and offer the right next action", () => {
  expect(renderStorage(false, true)).toContain("Your documents, within reach");
  const teamHtml = renderStorage(true);
  expect(teamHtml).not.toContain("Office documents");
  expect(teamHtml).not.toContain(">Add storage<");
  expect(teamHtml).toContain("No file storage shared by your firm yet.");
});

test("the storage source tabs include optional team sources and isolate personal and team entries", () => {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const local = { ...storageInputSchema.parse({ name: "Personal files", config: { kind: "webdav", endpoint: "https://example.invalid/files" } }), id: "local", updatedAt: 1, configuredSecrets: [] };
  const shared = { ...local, id: "shared", name: "Team documents", teamInstallation: "optional", team: { orgId: "firm", version: 1, installed: false } };
  queries.setQueryData(["storage-connections", "test"], { connections: [local, shared] });
  queries.setQueryData(["storage-oauth-providers", "test"], { providers: [] });
  const html = renderToStaticMarkup(<QueryClientProvider client={queries}><IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null }}><HubScopeContext.Provider value="local"><FileStorageView client={createLegalworkServerClient({ baseUrl: "https://example.invalid" })} workspaceId="test" /></HubScopeContext.Provider></IntegrationLibraryLayoutContext.Provider></QueryClientProvider>);
  expect(html).toContain("Personal files");
  expect(html).toContain("Team documents");
  expect(html).toContain(">Team<");
  expect(html).toContain('aria-label="Actions for Personal files"');
  expect(html).toContain('aria-label="Actions for Team documents"');
  expect(html).not.toContain('aria-label="Edit Personal files"');
  expect(html).not.toContain('aria-label="Edit Team documents"');
  expect(html).not.toContain('aria-label="Disconnect Team documents"');
  for (const source of ["personal", "team"]) {
    const filtered = renderToStaticMarkup(<QueryClientProvider client={queries}><IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, source: source === "team" ? "team" : "personal" }}><HubScopeContext.Provider value="local"><FileStorageView client={createLegalworkServerClient({ baseUrl: "https://example.invalid" })} workspaceId="test" /></HubScopeContext.Provider></IntegrationLibraryLayoutContext.Provider></QueryClientProvider>);
    expect(filtered).toContain(source === "team" ? "Team documents" : "Personal files");
    expect(filtered).not.toContain(source === "team" ? "Personal files" : "Team documents");
  }
  queries.clear();
});
