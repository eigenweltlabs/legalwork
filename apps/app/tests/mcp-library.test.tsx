import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpView, type McpViewProps } from "../src/react-app/domains/settings/pages/mcp-view";
import type { McpDirectoryInfo } from "../src/app/constants";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FirmHubItem } from "@legalwork/types/firm-hub";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { FIRM_HUB_QUERY_KEY } from "../src/react-app/domains/connections/firm-hub";
import { IntegrationLibraryLayoutContext, type IntegrationLibrarySource } from "../src/react-app/domains/settings/pages/integration-library";
import type { ImportedPlugin } from "../src/app/lib/extension-imports";
import type { McpStatus } from "../src/app/types";
import { McpMigrationRecovery } from "../src/react-app/domains/settings/pages/connector-status";

const noop = () => {};
const attioUrl = "https://example.invalid/attio";
const attio: McpDirectoryInfo = { name: "Attio", serverName: "attio", description: "Manage your CRM", type: "remote", url: attioUrl, oauth: true, iconSlug: "attio" };
const available: McpDirectoryInfo = { name: "Directory-only tool", serverName: "directory-only", description: "Available to connect", oauth: false };
const native: McpDirectoryInfo = { name: "Built-in Browser", serverName: "browser", description: "Browse with LegalWork", kind: "extension", oauth: false };
const props: McpViewProps = {
  busy: false, selectedWorkspaceRoot: "/project", isRemoteWorkspace: false,
  mcpServers: [
    { name: "paused", source: "config.remote", config: { type: "remote", url: "https://example.invalid/paused", enabled: false } },
    { name: "attio", source: "config.remote", config: { type: "remote", url: attioUrl, enabled: true } },
  ],
  mcpStatus: null, mcpStatuses: { attio: { status: "connected" } }, mcpConnectingName: null, selectedMcp: null,
  setSelectedMcp: noop, quickConnect: [attio, available, native], connectMcp: noop, authorizeMcp: noop, logoutMcpAuth: noop, removeMcp: noop,
  setMcpEnabled: async () => {}, isExtensionConnected: entry => entry === native,
};

test("migration recovery distinguishes waiting, blocked and inaccessible-vault actions", () => {
  const render = (state: "waiting" | "blocked", canReconnect: boolean) => renderToStaticMarkup(<McpMigrationRecovery migration={{ state, canReconnect }} message="Saved sign-in preserved; close the other app." busy={false} onRetry={async () => {}} onReconnect={noop} />);
  expect(render("waiting", true)).toContain("Transferring your saved sign-in");
  expect(render("waiting", true)).not.toContain("<button");
  const blocked = render("blocked", true);
  expect(blocked).toContain("Sign-in transfer needs attention");
  expect(blocked).toContain("Saved sign-in preserved; close the other app.");
  expect(blocked).toContain("Retry transfer");
  expect(blocked).toContain("Sign in again");
  expect(render("blocked", false)).toContain("Retry transfer");
  expect(render("blocked", false)).not.toContain("Sign in again");
});

test("connector library leads with saved connectors and exposes Browse directory separately", () => {
  const html = renderToStaticMarkup(<McpView {...props} />);
  expect(html).toContain("Browse directory");
  expect(html).toContain("lucide-plus");
  expect(html).toContain("Your connectors");
  expect(html).toContain("Manage your CRM");
  expect(html).not.toContain("Directory-only tool");
  expect(html).not.toContain("Available connectors");
  expect(html.match(/Manage your CRM/g)).toHaveLength(1);
});

test("ready connectors and active built-ins come before paused connectors without losing paused settings", () => {
  const html = renderToStaticMarkup(<McpView {...props} />);
  expect(html.indexOf("Attio")).toBeLessThan(html.indexOf(">paused<"));
  expect(html.indexOf("Built-in Browser")).toBeLessThan(html.indexOf(">paused<"));
  expect(html).toContain('aria-label="Actions for paused"');
  expect(html).toContain('aria-label="Actions for Attio"');
  expect(html).not.toContain('role="switch"');
  expect(html.match(/Enable to use/g)).toHaveLength(1);
  expect(html).not.toContain(">Ready<");
  expect(html).not.toContain(">Paused<");
});

test("empty library points to directory or own connector instead of rendering the catalog", () => {
  const html = renderToStaticMarkup(<McpView {...props} mcpServers={[]} isExtensionConnected={() => false} />);
  expect(html).toContain("Browse the directory or add your own connector");
  expect(html).not.toContain("Directory-only tool");
});

test("global config file connectors retain their existing read-only toggle behavior", () => {
  const html = renderToStaticMarkup(<McpView {...props} quickConnect={[]} mcpServers={[
    { name: "managed", source: "config.global", config: { type: "remote", url: "https://example.invalid/managed" } },
  ]} />);
  expect(html).toContain("managed");
  expect(html).not.toContain('role="switch"');
});

function renderTeamLibrary(items: FirmHubItem[], overrides: Partial<McpViewProps> = {}, source: IntegrationLibrarySource = "all") {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queries.setQueryData(FIRM_HUB_QUERY_KEY, { connected: true, items });
  const html = renderToStaticMarkup(<QueryClientProvider client={queries}><IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, source }}><McpView {...props} {...overrides} firmClient={createLegalworkServerClient({ baseUrl: "https://example.invalid" })} /></IntegrationLibraryLayoutContext.Provider></QueryClientProvider>);
  queries.clear();
  return html;
}

const teamResearch: FirmHubItem = { id: "research", kind: "mcp", name: "team-research", description: "Search the firm's research library", installation: "automatic", added: false, connector: { serverName: "research", url: "https://example.invalid/research", access: "firm", keyName: null, hasOwnKey: false } };

const matchingStates: { state?: McpStatus; label: string | null; dot: string | null }[] = [
  { state: { status: "needs_auth" }, label: "Sign in to use it", dot: "bg-amber-9" },
  { state: { status: "needs_client_registration", error: "Client registration required" }, label: "Sign-in setup is incomplete", dot: "bg-amber-9" },
  { state: { status: "failed", error: "Connection refused" }, label: "Issue", dot: "bg-red-9" },
  { state: { status: "disabled" }, label: "Enable to use", dot: null },
  { state: { status: "connected" }, label: null, dot: null },
  { label: "Offline", dot: "bg-gray-7" },
];

for (const { state, label, dot } of matchingStates) {
  test(`personal, plugin and team connector rows present ${state?.status ?? "disconnected"} consistently`, () => {
    const plugin: ImportedPlugin = { pluginId: "research-plugin", marketplaceId: null, name: "research-plugin", description: null, updatedAt: null, importedAt: 1, files: [
      { configObjectId: "plugin-server", versionId: null, objectType: "mcp", title: "Research plugin", path: "opencode.jsonc#mcp.plugin-server", updatedAt: null },
    ] };
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(FIRM_HUB_QUERY_KEY, { connected: true, items: [{ ...teamResearch, connector: { ...teamResearch.connector!, access: state ? "oauth" : "firm" } }] });
    const html = renderToStaticMarkup(<QueryClientProvider client={queries}><IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, importedPackages: [plugin] }}><McpView {...props} quickConnect={[]} mcpServers={[
      { name: "personal", config: { type: "remote", url: "https://example.invalid/personal" } },
      { name: "plugin-server", config: { type: "remote", url: "https://example.invalid/plugin" } },
    ]} mcpStatuses={state ? { personal: state, "plugin-server": state, research: state } : {}} firmClient={createLegalworkServerClient({ baseUrl: "https://example.invalid" })} /></IntegrationLibraryLayoutContext.Provider></QueryClientProvider>);
    queries.clear();
    expect(html).toContain("Plugin: Research Plugin");
    expect(html).toContain(">Team<");
    if (label) expect(html.split(label)).toHaveLength(4);
    if (dot) expect(html.split(dot)).toHaveLength(4);
    else expect(html).not.toContain("rounded-full");
    expect(html).not.toContain("Sign in needed");
    expect(html).not.toContain("Not reachable right now");
    expect(html).not.toContain(">Ready<");
    expect(html).not.toContain(">Paused<");
  });
}

test("source tabs isolate connectors without misclassifying team engine configuration as personal", () => {
  const overrides = { mcpServers: [...props.mcpServers, { name: "research", config: { type: "remote", url: "https://example.invalid/research" } }] };
  const personal = renderTeamLibrary([teamResearch], overrides, "personal");
  expect(personal).toContain("Manage your CRM");
  expect(personal).not.toContain("Team Research");
  expect(personal).not.toContain('aria-label="Actions for research"');
  const team = renderTeamLibrary([teamResearch, { ...teamResearch, id: "optional", name: "offered-tool", installation: "optional" }], overrides, "team");
  expect(team).toContain("Team Research");
  expect(team).toContain("Offered Tool");
  expect(team).not.toContain("Manage your CRM");
  expect(team).not.toContain("Built-in Browser");
});

test("team connectors share the personal list, deduplicate engine config and retain managed ownership", () => {
  const html = renderTeamLibrary([teamResearch], {
    mcpServers: [...props.mcpServers, { name: "research", source: "config.remote", config: { type: "remote", url: "https://example.invalid/research" } }],
    mcpStatuses: { ...props.mcpStatuses, research: { status: "connected" } },
  });
  expect(html).toContain("Team Research");
  expect(html).toContain("Manage your CRM");
  expect(html).toContain(">Team<");
  expect(html.match(/Search the firm&#x27;s research library/g)).toHaveLength(1);
  expect(html).not.toContain('aria-label="Disable research"');
  expect(html).not.toContain('aria-label="Disable Team Research"');
  expect(html).not.toContain("Installed for everyone</");
});

test("optional team connectors remain discoverable without exposing account actions before adding", () => {
  const html = renderTeamLibrary([{ ...teamResearch, installation: "optional", connector: { ...teamResearch.connector!, access: "oauth" } }]);
  expect(html).toContain('aria-label="Actions for Team Research"');
  expect(html).not.toContain('role="switch"');
  expect(html).not.toContain(">Sign in<");
  expect(html).not.toContain("Sign in to use it");
  expect(html.match(/Enable to use/g)).toHaveLength(2);
});

test("team connector account and key requirements remain visible without inline controls", () => {
  const oauth = renderTeamLibrary([{ ...teamResearch, installation: "optional", added: true, connector: { ...teamResearch.connector!, access: "oauth" } }], { mcpStatuses: { research: { status: "needs_auth" } } });
  expect(oauth).toContain("Sign in to use it");
  expect(oauth).toContain('aria-label="Actions for Team Research"');
  const member = renderTeamLibrary([{ ...teamResearch, connector: { ...teamResearch.connector!, access: "member" } }]);
  expect(member).toContain("Add your key to use it");
  expect(member).toContain("bg-amber-9");
});

test("automatically installed team OAuth connectors show sign-in before the engine checks them", () => {
  const item: FirmHubItem = { ...teamResearch, connector: { ...teamResearch.connector!, access: "oauth" } };
  for (const mcpStatuses of [{}, { research: { status: "disconnected" } }]) {
    const html = renderTeamLibrary([item], { mcpStatuses });
    expect(html).toContain("Sign in to use it");
    expect(html).toContain('aria-label="Actions for Team Research"');
  }
});

test("team-only libraries retain account actions without legacy empty/configuration banners", () => {
  const item: FirmHubItem = { ...teamResearch, connector: { ...teamResearch.connector!, access: "oauth" } };
  const html = renderTeamLibrary([item], { mcpServers: [], quickConnect: [], mcpStatuses: {} });
  expect(html).toContain("Team Research");
  expect(html).toContain("Sign in to use it");
  expect(html).not.toMatch(/No MCP|opencode\.json|Advanced settings|Synced|No connectors connected yet/);
});

test("connected and failed team OAuth connectors retain their actual state", () => {
  const item: FirmHubItem = { ...teamResearch, connector: { ...teamResearch.connector!, access: "oauth" } };
  const connected = renderTeamLibrary([item], { mcpStatuses: { research: { status: "connected" } } });
  expect(connected).not.toContain("Sign in to use it");
  expect(connected.match(/Enable to use/g)).toHaveLength(1);
  const failed = renderTeamLibrary([item], { mcpStatuses: { research: { status: "failed", error: "Connection refused" } } });
  expect(failed).toContain("Issue");
  expect(failed).not.toContain("Sign in to use it");
});

test("plugin connectors appear once in the main library with their owning package and activation requirement", () => {
  const plugin: ImportedPlugin = { pluginId: "patent", marketplaceId: null, name: "patent-studio", displayName: "Patent Studio", description: null, updatedAt: null, importedAt: 1, files: [
    { configObjectId: "search", versionId: null, objectType: "mcp", title: "Patent Studio", path: "opencode.jsonc#mcp.paused", updatedAt: null },
    { configObjectId: "missing", versionId: null, objectType: "mcp", title: "Not installed", path: "opencode.jsonc#mcp.not-installed", updatedAt: null },
  ] };
  const html = renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, importedPackages: [plugin] }}><McpView {...props} /></IntegrationLibraryLayoutContext.Provider>);
  expect(html.match(/aria-label="Actions for paused"/g)).toHaveLength(1);
  expect(html.match(/Plugin: Patent Studio/g)).toHaveLength(1);
  expect(html).toContain("Manage your CRM");
  expect(html).toContain("Enable to use");
  expect(html).not.toContain("Not installed");
});

test("unified Plugins search includes standalone connectors and hides components already represented by a package", () => {
  const plugin: ImportedPlugin = { pluginId: "research", marketplaceId: null, name: "research", description: "Research bundle", updatedAt: null, importedAt: 1, files: [
    { configObjectId: "attio", versionId: null, objectType: "mcp", title: "Attio", path: "opencode.jsonc#mcp.attio", updatedAt: null },
  ] };
  const render = (pluginSearch: string) => renderToStaticMarkup(<IntegrationLibraryLayoutContext.Provider value={{ actions: null, search: null, pluginSearch, importedPackages: [plugin] }}><McpView {...props} /></IntegrationLibraryLayoutContext.Provider>);
  const all = render("");
  expect(all).toContain('aria-label="Actions for paused"');
  expect(all).not.toContain('aria-label="Actions for Attio"');
  expect(render("paused")).not.toContain("Built-in Browser");
  expect(render("research")).not.toContain("No matching plugins");
  expect(render("missing")).toContain("No matching plugins");
});
