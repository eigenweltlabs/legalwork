import { expect, test } from "bun:test";
import { groupPluginImportCandidates, importedConnectorPlugin, importedSkillPlugin, pluginImportCandidateKey, pluginImportConnectorName, pluginImportDestination, pluginImportName, pluginImportSkillName } from "../src/react-app/domains/settings/pages/plugin-import-presentation";
import type { PluginImportPreview } from "@legalwork/types/plugin-import";
import { readWorkspaceImports } from "../src/app/lib/extension-imports";
import { packageParts } from "../src/react-app/domains/settings/pages/plugin-package-contents";

test("whole plugins containing one connector remain plugins; only connector imports open connector setup", () => {
  const preview: PluginImportPreview = { id: "import:claude:github:global", digest: "reviewed", name: "github", description: null, version: null, format: "claude", root: "", fileCount: 2, bytes: 300, warnings: [], components: [{ type: "mcp", name: "github", installedName: "github-unique-installed-name" }] };
  for (const format of ["claude", "codex", "portable"] satisfies PluginImportPreview["format"][]) {
    expect(pluginImportDestination({ ...preview, format })).toEqual({ tab: "plugins", connectorName: null });
  }
  expect(pluginImportDestination({ ...preview, format: "connectors" })).toEqual({ tab: "connectors", connectorName: "github-unique-installed-name" });
  expect(pluginImportDestination({ ...preview, format: "connectors", components: [...preview.components, { type: "mcp", name: "other", installedName: "another-unique-name" }] })).toEqual({ tab: "connectors", connectorName: null });
  expect(pluginImportDestination({ ...preview, format: "skills", components: [{ type: "skill", name: "review", installedName: "review-installed-name" }] })).toEqual({ tab: "skills", connectorName: null });
});

test("converted plugin reviews count workflows without relabelling connectors, agents or commands", () => {
  expect(packageParts(["skill", "mcp"], true)).toBe("1 workflow · 1 connector");
  expect(packageParts(["skill", "skill", "agent", "command"], true)).toBe("2 workflows · 1 command · 1 agent");
  expect(packageParts(["skill", "mcp"])).toBe("1 skill · 1 connector");
});

test("provider display names hide internal app IDs without changing plugin identity", () => {
  expect(pluginImportName({ name: "app-6a9a3c1cd0108191807da33c4cd319ed", displayName: "Clerk" })).toBe("Clerk");
  expect(pluginImportName({ name: "google-drive" })).toBe("Google Drive");
  const skill = { name: "patent-studio-2cbe85ce-claim-review", path: "/home/skills/patent-studio-2cbe85ce-plugin/patent-studio-2cbe85ce-claim-review/SKILL.md" };
  expect(pluginImportSkillName(skill)).toBe("Claim Review");
  expect(pluginImportSkillName({ ...skill, path: skill.path.replace("/SKILL.md", "") })).toBe("Claim Review");
  expect(skill.name).toBe("patent-studio-2cbe85ce-claim-review");
  expect(pluginImportSkillName({ ...skill, path: "/home/skills/custom/SKILL.md" })).toBe(skill.name);
  expect(pluginImportSkillName({ ...skill, path: skill.path.replace(/\//g, "\\") })).toBe("Claim Review");
  expect(pluginImportSkillName({ name: `workflow-assistant-${skill.name}`, path: skill.path.replace(skill.name, `workflow-assistant-${skill.name}`) })).toBe("Claim Review");
});

test("discovery groups copies by canonical identity and keeps the latest version plus all source choices", () => {
  const groups = groupPluginImportCandidates([
    { name: "search", displayName: "Search", path: "/cache/old", version: "1.9" },
    { name: "search", displayName: "Search", path: "/cache/new", version: "1.10" },
    { name: "other-search", displayName: "Search", path: "/cache/other", version: "1" },
  ]);
  expect(groups).toHaveLength(2);
  const search = groups.find(group => group.candidate.name === "search");
  expect(search?.candidate.path).toBe("/cache/new");
  expect(search?.sources.map(source => source.path)).toEqual(["/cache/new", "/cache/old"]);
});

test("installed package parsing retains its display name and all-projects scope", () => {
  const imports = readWorkspaceImports({ cloudImports: { plugins: { internal: {
    pluginId: "internal", name: "app-internal", displayName: "Clerk", scope: "global", files: [],
    sourceKind: "plugin",
  } } } });
  expect(imports.plugins.internal?.name).toBe("app-internal");
  expect(imports.plugins.internal?.displayName).toBe("Clerk");
  expect(imports.plugins.internal?.scope).toBe("global");
  expect(imports.plugins.internal?.sourceKind).toBe("plugin");
});

test("connector discovery keeps same-name services and same-file entries independently selectable", () => {
  const groups = groupPluginImportCandidates([
    { name: "search", path: "/home/.claude.json", version: null, kind: "connector", connector: { name: "search" } },
    { name: "search", path: "/home/.claude.json", version: null, kind: "connector", connector: { name: "search", project: "/project" } },
    { name: "docket", path: "/home/.claude.json", version: null, kind: "connector", connector: { name: "docket" } },
    { name: "search", path: "/plugin", version: "1", kind: "plugin" },
  ]);
  expect(groups).toHaveLength(4);
  expect(pluginImportConnectorName("connector-search-abcdef12-12345678-plugin-global-patent-search-abcdef")).toBe("Patent Search");
  expect(pluginImportConnectorName("custom-search")).toBe("custom-search");
});

test("bundled connectors group their plugin's versions while keeping other plugins and standalone configs separate", () => {
  const connector = { name: "search", pluginRoot: "" };
  const bundled = { name: "search", kind: "connector", connector, bundledIn: { name: "patent", displayName: "Patent Studio" } } satisfies Partial<import("@legalwork/types/plugin-import").PluginImportCandidate>;
  const latest = { ...bundled, path: "/cache/new", version: "1.10" };
  const groups = groupPluginImportCandidates([
    latest,
    { ...bundled, path: "/cache/old", version: "1.9" },
    { ...bundled, bundledIn: { name: "other-patent", displayName: "Patent Studio" }, path: "/cache/other", version: "1" },
    { name: "search", path: "/config.json", version: null, kind: "connector", connector: { name: "search" } },
    { name: "patent", path: "/cache/new", version: "1.10", kind: "plugin" },
  ]);
  expect(groups).toHaveLength(4);
  const copies = groups.find(group => group.candidate.bundledIn?.name === "patent");
  expect(copies?.candidate.path).toBe("/cache/new");
  expect(copies?.sources.map(source => source.connector)).toEqual([connector, connector]);
  expect(pluginImportCandidateKey(latest)).not.toBe(pluginImportCandidateKey({ ...latest, connector: { name: "search" } }));
  expect(pluginImportCandidateKey(latest)).not.toBe(pluginImportCandidateKey({ ...latest, connector: { name: "search", pluginRoot: "nested" } }));
});

test("plugin ownership follows recorded skill and connector destinations across global, project and Windows paths", () => {
  const plugins = Object.values(readWorkspaceImports({ cloudImports: { plugins: { patent: {
    pluginId: "patent", name: "patent-studio", displayName: "Patent Studio", files: [
      { configObjectId: "review", objectType: "skill", title: "Claim Review", path: ".opencode/skills/patent-studio-plugin/claim-review/SKILL.md" },
      { configObjectId: "search", objectType: "mcp", title: "Patent Search", path: "opencode.jsonc#mcp.patent-search" },
    ],
  } } } }).plugins);
  for (const path of ["/home/.config/opencode/skills/patent-studio-plugin/claim-review", "/project/.opencode/skills/patent-studio-plugin/claim-review/SKILL.md", "C:\\Users\\Tester\\.config\\opencode\\skills\\patent-studio-plugin\\claim-review\\SKILL.md"]) {
    expect(importedSkillPlugin({ path }, plugins)?.pluginId).toBe("patent");
  }
  expect(importedSkillPlugin({ path: "/project/.opencode/skills/claim-review/SKILL.md" }, plugins)).toBeUndefined();
  expect(importedSkillPlugin({ path: "/project/.opencode/skills/other-patent-studio-plugin/claim-review/SKILL.md" }, plugins)).toBeUndefined();
  expect(importedConnectorPlugin("patent-search", plugins)?.pluginId).toBe("patent");
  expect(importedConnectorPlugin("patent-search-copy", plugins)).toBeUndefined();
  expect(importedConnectorPlugin("patent-search", [])).toBeUndefined();
  expect(importedConnectorPlugin("patent-search", plugins.map(plugin => ({ ...plugin, sourceKind: "connector" })))).toBeUndefined();
  expect(importedSkillPlugin({ path: "/global/skills/patent-studio-plugin/claim-review" }, plugins.map(plugin => ({ ...plugin, sourceKind: "skill" })))).toBeUndefined();
});
