import { connectorCategory, popularConnector } from "../src/react-app/domains/settings/pages/connector-categories";
import { expect, test } from "bun:test";
import { MCP_QUICK_CONNECT } from "../src/app/constants";
import type { ImportedPlugin } from "../src/app/lib/extension-imports";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { storageInputSchema } from "@legalwork/types/file-storage";
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform";
import { McpView } from "../src/react-app/domains/settings/pages/mcp-view";
import { ExtensionsView, type ExtensionsViewProps } from "../src/react-app/domains/settings/pages/extensions-view";
import { composerSettingsPath } from "../src/react-app/shell/workspace-routes";

const noop = () => {};
const client = createLegalworkServerClient({ baseUrl: "https://example.invalid", hostToken: "test-host" });
const props: ExtensionsViewProps = {
  client, storageWorkspaceId: "test", workspaceKey: "test", libraryConnection: client,
  busy: false, developerMode: false, selectedWorkspaceRoot: "/test", isRemoteWorkspace: false,
  canEditPlugins: true, canUseGlobalScope: true, suggestedPlugins: [], onRefresh: noop,
  extensions: { pluginScope: "global", setPluginScope: noop, refreshPlugins: noop, pluginConfigPath: () => null, pluginConfig: () => null, pluginList: () => [], pluginInput: () => "", setPluginInput: noop, pluginStatus: () => null, addPlugin: noop, removePlugin: noop, isPluginInstalledByName: () => false, activePluginGuide: () => null, setActivePluginGuide: noop },
  skillTools: { importedPackages: async () => [], removeImportedPackage: async () => {}, revealSkillsFolder: noop },
  mcpView: <McpView busy={false} selectedWorkspaceRoot="/test" isRemoteWorkspace={false} mcpServers={[]} mcpStatus={null} mcpStatuses={{}} mcpConnectingName={null} selectedMcp={null} setSelectedMcp={noop} quickConnect={[]} connectMcp={noop} authorizeMcp={noop} logoutMcpAuth={noop} removeMcp={noop} />,
};
function render(connection?: string, overrides: Partial<ExtensionsViewProps> = {}, packages: ImportedPlugin[] = [], firm = false) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(["settings", "connector-accounts", client.baseUrl], { configured: true, requiresSignIn: false, connectors: [{ id: "gmail", connections: [{ id: "personal", needsReconnect: true }] }] });
  const storage = { ...storageInputSchema.parse({ name: "Matter documents", config: { kind: "webdav", endpoint: "https://example.invalid/files" } }), id: "first", updatedAt: 1, configuredSecrets: [], ...(firm ? { team: { orgId: "firm", version: 1, installed: true } } : {}) };
  cache.setQueryData(["storage-connections", "test"], { connections: [storage, { ...storage, id: "second", name: "Archive documents" }] });
  cache.setQueryData(["storage-oauth-providers", "test"], { providers: [{ id: "dropbox", name: "Dropbox", rootHint: "Folder path" }] });
  cache.setQueryData(["browser-passwords", client.baseUrl], { items: [{ id: "beck-personal", label: "Beck personal", origin: "https://beck-online.beck.de", username: "test", websites: [{ providerId: "beck-online", url: "https://beck-online.beck.de/Home", name: "beck-online" }] }] });
  cache.setQueryData(["integration-packages", client.baseUrl, "test"], packages);
  cache.setQueryData(["firm-hub"], { items: [] });
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={[`/settings/extensions${connection ? `?connection=${encodeURIComponent(connection)}` : ""}`]}><QueryClientProvider client={cache}><PlatformProvider value={createDefaultPlatform()}><ExtensionsView {...props} {...overrides} /></PlatformProvider></QueryClientProvider></MemoryRouter>);
  cache.clear(); return html;
}

test("catalogue presents user categories and a unified installed sidebar", () => {
  const html = render();
  const sidebar = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
  for (const name of ["Gmail", "Matter documents", "Archive documents", "Beck personal"]) expect(sidebar).toContain(name);
  for (const name of ["Popular", "Communication", "Files &amp; storage", "Legal databases", "Practice management", "Research &amp; productivity"]) expect(html).toContain(name);
  expect(html).not.toContain('role="tab"');
  expect(html).not.toContain(">Plugins<");
  expect(html).not.toContain(">Skills<");
});

test("direct links open the exact named storage instance with manage, remove and add-another", () => {
  const html = render("saved-storage:second");
  const article = html.slice(html.indexOf("<article"));
  expect(article).toContain("Archive documents</h1>");
  expect(article).toContain("Manage");
  expect(article).toContain('aria-label="Remove Archive documents"');
  expect(article).toContain("Add another connection");
  expect(article).not.toContain("Matter documents");
  expect(article).not.toContain("Your connections");
  expect(article).toContain("1 connection");
  expect(article).not.toContain("2 connections");
});

test("browse categories show providers and counts while named connections stay in Installed", () => {
  const html = render(undefined, { initialSection: "storage" });
  const sidebar = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
  const catalog = html.slice(html.indexOf("<section"));
  for (const name of ["Matter documents", "Archive documents", "Beck personal"]) {
    expect(sidebar).toContain(name);
    expect(catalog).not.toContain(name);
  }
  expect(catalog).toContain("WebDAV");
  expect(catalog).toContain("S3-compatible storage");
  expect(catalog).toContain("2 connections");
});

test("legal database details expose saved accounts without showing credentials", () => {
  const html = render("research:beck-online");
  expect(html).toContain("Your saved logins");
  expect(html).toContain("Beck personal");
  expect(html).toContain("Visit website");
  expect(html).not.toContain('type="password"');
  expect(html).toContain("Website Login");
  expect(render("saved-research:beck-personal")).not.toContain("Your saved logins");
});

test("an expired native account remains installed and shows its sign-in state", () => {
  expect(render("native:gmail")).toContain("Sign in to use it");
});

test("removed connection links offer recovery and skills links target Workflows", () => {
  expect(render("saved-storage:removed")).toContain("This connection is no longer available");
  expect(composerSettingsPath("skills")).toBe("/settings/workflows/skills");
});


test("legacy connector and plugin links open the unified catalog, including read-only clients", () => {
  for (const initialSection of ["mcp", "plugins"] satisfies ExtensionsViewProps["initialSection"][]) {
    for (const canEditPlugins of [true, false]) {
      const html = render(undefined, { initialSection, canEditPlugins });
      expect(html).toContain("Browse integrations");
      expect(html).toContain("Gmail");
      expect(html).not.toContain(">Plugins<");
      expect(html).not.toContain(">Skills<");
      expect(html).not.toContain("Engine plugins");
      expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>[\s\S]*?Add/);
    }
  }
});


test("provider pages list saved instances while individual connections stay independent", () => {
  const html = render("storage:webdav");
  const article = html.slice(html.indexOf("<article"));
  expect(article).toContain("Your connections");
  expect(article).toContain("Matter documents");
  expect(article).toContain("Archive documents");
  expect(article).toContain("File Storage Integration");
  expect(article).toContain("2 connections");
});


test("imported connections display both methods from their installed components", () => {
  const plugin: ImportedPlugin = {
    pluginId: "research-tools", marketplaceId: null, name: "Research tools", description: null, updatedAt: null, importedAt: 1,
    files: [
      { configObjectId: "review", versionId: null, objectType: "skill", title: "Review", path: ".opencode/skills/review/SKILL.md", updatedAt: null },
      { configObjectId: "search", versionId: null, objectType: "mcp", title: "Search", path: "opencode.jsonc#mcp.search", updatedAt: null },
    ],
  };
  const html = render("package:research-tools", {}, [plugin]);
  const article = html.slice(html.indexOf("<article"));
  expect(article).toContain('aria-label="How it works"');
  expect(article).toContain(">Skill<");
  expect(article).toContain(">MCP<");
  expect(article).not.toContain("Integration API");
});


test("catalogue and detail pages show saved connection counts without claiming a verified website sign-in", () => {
  expect(render()).toContain("2 connections");
  const connected = render("research:beck-online");
  expect(connected).toContain("1 saved login");
  expect(connected).not.toContain("No saved logins yet");
  expect(render("research:juris")).toContain("No saved logins yet");
  expect(render("native:gmail")).toContain("1 connection");
});


test("connection details surface ownership, permissions and file storage type", () => {
  const own = render("saved-storage:first").split("<article")[1];
  expect(own).toContain("My own");
  expect(own).toContain("Ownership");
  expect(own).toContain("Access");
  expect(own).toContain("File Storage Integration");
  expect(own).not.toContain("In Memory Drive");
  const firm = render("saved-storage:first", {}, [], true).split("<article")[1];
  expect(firm).toContain("Firm managed");
  expect(firm).not.toContain("My own");
  expect(firm).not.toContain('aria-label="Remove Matter documents"');
});

test("SharePoint and Dropbox each have one catalog provider and preserve custom links", () => {
  const overrides = { mcpView: <McpView {...props.mcpView.props} quickConnect={MCP_QUICK_CONNECT.filter(entry => entry.serverName === "dropbox" || entry.serverName === "sharepoint")} /> };
  const catalog = render(undefined, { ...overrides, initialSection: "storage" }).split("<section")[1];
  expect(catalog.match(/>SharePoint</g)).toHaveLength(1);
  expect(catalog.match(/>Dropbox</g)).toHaveLength(1);
  expect(catalog).not.toContain("Custom SharePoint");
  expect(catalog).not.toContain("Custom Dropbox");
  expect(render("service:sharepoint", overrides)).toContain("Custom SharePoint</h1>");
  expect(render("service:dropbox", overrides)).toContain("Custom Dropbox</h1>");
});


test("catalog categories place storage and Eigenwelt tools correctly and omit the retired Google bundle", () => {
  for (const name of ["box", "egnyte", "dropbox", "sharepoint"]) expect(connectorCategory(name, name)).toBe("files");
  for (const name of ["legalmemory", "open-computer-use", "legalwork-ui"]) expect(connectorCategory(name, name)).toBe("eigenwelt");
  for (const name of ["beck-online", "juris", "legalmemory"]) expect(popularConnector(name)).toBe(false);
  expect(MCP_QUICK_CONNECT.some(item => item.id === "google-workspace")).toBe(false);
  const ui = MCP_QUICK_CONNECT.find(item => item.serverName === "legalwork-ui");
  expect(ui?.iconSrc).toContain("legalwork-mark-dark.svg");
  expect(render()).toContain("Eigenwelt Extensions");
});
