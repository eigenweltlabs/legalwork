import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImportedPlugin } from "../src/app/lib/extension-imports";
import { ComposerToolMenu } from "../src/react-app/domains/session/surface/composer/tool-menu";
import { composerSettingsPath, sessionMainPage, type ComposerToolSection } from "../src/react-app/shell/workspace-routes";

const connectorName = "github-12345678-plugin-global-github-abcdef";
const plugin: ImportedPlugin = {
  name: "github", pluginId: "github", description: "Manage repositories", marketplaceId: null, importedAt: null, updatedAt: null,
  files: [{ configObjectId: "github-connector", objectType: "mcp", title: connectorName, path: `opencode.jsonc#mcp.${connectorName}`, updatedAt: null }],
};
const noop = () => {};
function render(section: ComposerToolSection, overrides: Partial<Parameters<typeof ComposerToolMenu>[0]> = {}) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ComposerToolMenu section={section} onSectionChange={noop} onConfigure={noop} onSelectSkill={noop} onSelectPlugin={noop} onSelectIntegration={noop}
    skillsLoading={false} connectorsLoading={false} pluginsLoading={false} skills={[]} connectors={[]} connectorStatuses={{}} plugins={[]} {...overrides} /></QueryClientProvider>);
}

describe("chat library menu", () => {
  test("has the three current categories and sends Configure to their actual pages", () => {
    const html = render("workflows");
    const categories = [...html.matchAll(/aria-pressed="(?:true|false)"[^>]*><span[^>]*>([^<]+)</g)].map(match => match[1]);
    expect(categories).toEqual(["Workflows", "Skills", "Integrations"]);
    expect(composerSettingsPath("plugins")).toBe("/settings/extensions/plugins");
    expect(composerSettingsPath("connectors")).toBe("/settings/extensions/mcp");
    expect(composerSettingsPath("integrations")).toBe("/settings/extensions");
    expect(composerSettingsPath("skills")).toBe("/settings/workflows/skills");
    expect(sessionMainPage(composerSettingsPath("workflows"))).toBe("workflows");
    expect(composerSettingsPath("providers")).toBe("/settings/ai");
  });

  test("uses workflow metadata and legacy workflow names, leaving regular skills in Skills", () => {
    const skills = [
      { name: "workflow-assistant-contract-review", path: "review/SKILL.md", description: "Review agreements" },
      { name: "due-diligence", path: "due/SKILL.md", description: "Review data rooms", kind: "workflow" },
      { name: "contract-analysis", path: "analysis/SKILL.md", description: "Analyze clauses" },
    ];
    const workflows = render("workflows", { skills });
    expect(workflows).toContain("Contract Review");
    expect(workflows).toContain("Review data rooms");
    expect(workflows).not.toContain("Analyze clauses");
    const ordinary = render("skills", { skills });
    expect(ordinary).toContain("Analyze clauses");
    expect(ordinary).not.toContain("Review agreements");
    expect(ordinary).not.toContain("Review data rooms");
  });

  test("shows readable connector names and shared state messages without exposing configuration", () => {
    const html = render("integrations", { connectors: [
      { name: connectorName, config: { type: "remote", url: "https://private-connector.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, enabled: false } },
      { name: "linear", config: { type: "remote", enabled: false } },
      { name: "notion", config: { type: "remote" } },
    ], connectorStatuses: { notion: { status: "needs_auth" } }, plugins: [plugin] });
    expect(html).toContain("Github");
    expect(html).toContain("1 connector needs setup");
    expect(html).toContain("Enable to use");
    expect(html).not.toContain("Plugin: Github");
    expect(html).toContain("Sign in to use it");
    expect(html).not.toContain(connectorName);
    expect(html).not.toContain("private-connector.example");
    expect(html).not.toContain("${TOKEN}");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Paused");
  });

  test("team connectors without a member's credentials stay visible with a setup message", () => {
    const html = render("integrations", { connectors: [{ name: "firm_internal_id", displayName: "Case records", description: "Search firm records", config: { type: "remote" }, firm: true, state: "needs_key" }] });
    expect(html).toContain("Case records");
    expect(html).toContain("Team");
    expect(html).toContain("Add your key to use it");
    expect(html).not.toContain("firm_internal_id");
  });

  test("Integrations includes whole global or project packages and excludes standalone import wrappers", () => {
    const html = render("integrations", { plugins: [plugin, { ...plugin, name: "global-plugin", pluginId: "global", scope: "global" }, { ...plugin, name: "standalone-skill", pluginId: "skill", sourceKind: "skill" }, { ...plugin, name: "standalone-connector", pluginId: "connector", sourceKind: "connector" }], connectors: [{ name: connectorName, config: { type: "remote", enabled: false } }] });
    expect(html).toContain("Github");
    expect(html).toContain("Global Plugin");
    expect((html.match(/>Github</g) ?? [])).toHaveLength(1);
    expect(html).toContain("1 connector needs setup");
    expect(html).not.toContain("Standalone Skill");
    expect(html).not.toContain("Standalone Connector");
  });

  test("empty and loading categories use current terminology", () => {
    expect(render("integrations", { pluginsLoading: true })).toContain("Loading…");
    expect(render("integrations")).toContain("No integrations connected yet.");
    expect(render("workflows")).toContain("No workflows available.");
    expect(render("integrations")).toContain("No integrations connected yet.");
  });

  test("plugin rows offer direct selection and a separate contents action", () => {
    const html = render("integrations", { plugins: [plugin] });
    expect(html).toContain('aria-label="Use Github"');
    expect(html).toContain('aria-label="View Github contents"');
  });
});
