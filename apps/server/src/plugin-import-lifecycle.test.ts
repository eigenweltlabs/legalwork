import { expect, test } from "bun:test";
import type { PluginImportUpdate } from "@legalwork/types/plugin-import";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { resolvePluginImports, discoverPluginImports, parsePluginImportRequest } from "./plugin-imports.js";
import { preparePluginImport, reviewedPluginImport, assertImportable } from "./plugin-import-checks.js";
import { installPluginImport, rollbackPluginImport } from "./plugin-import-install.js";
import { readInstalledCloudPlugins, resolveWorkspaceInstallPath } from "./cloud-plugins.js";
import type { ServerConfig } from "./types.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import { parseFrontmatter } from "./frontmatter.js";

const skill = "---\nname: review\ndescription: Review documents\n---\nRead references/checklist.md.\n";
const schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
async function files(root: string, entries: Record<string, string>) { for (const [path, content] of Object.entries(entries)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); } }
async function fixture(run: (root: string, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-import-lifecycle-"));
  const previous = { discovery: process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME, claude: process.env.CLAUDE_CONFIG_DIR, db: process.env.LEGALWORK_RUNTIME_DB, xdg: process.env.XDG_CONFIG_HOME };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); process.env.XDG_CONFIG_HOME = join(root, "global");
  process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = join(root, "home"); process.env.CLAUDE_CONFIG_DIR = join(root, "home/.claude");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "owner", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  try { await run(root, config); }
  finally { if (previous.discovery === undefined) delete process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME; else process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = previous.discovery; if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude; if (previous.db === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous.db; if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg; await rm(root, { recursive: true, force: true }); }
}
async function plan(path: string, root: string) { const [value] = await resolvePluginImports({ source: { provider: "claude", path }, scope: "project" }, root); if (!value) throw new Error("No import plan"); return value; }

for (const provider of ["claude", "chatgpt"] satisfies Array<"claude" | "chatgpt">) {
  test(`${provider} plugin skills explicitly become workflows while the full plugin and connector survive install and update`, () => fixture(async (root, config) => {
    const source = join(root, "workflow-kit");
    const manifest = provider === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
    await files(source, {
      [manifest]: '{"name":"review-kit"}',
      "skills/review/SKILL.md": skill,
      "skills/review/references/checklist.md": "Check the document's main provisions.",
      "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Summarize findings\n---\nSummarize the findings.",
      "agents/reviewer.md": "---\nname: reviewer\ndescription: Review documents\n---\nReview the document.",
      "commands/report.md": "Prepare a report.",
      ".mcp.json": '{"mcpServers":{"docs":{"type":"http","url":"https://docs.example/mcp","headers":{"Authorization":"Bearer ${DOCS_KEY}"}}}}',
    });
    const request = { source: { provider, path: source }, scope: "global", asWorkflow: true, workflowSkillsOnly: true } satisfies Parameters<typeof resolvePluginImports>[0];
    const [ordinary] = await resolvePluginImports(request, root);
    expect(ordinary?.preview.components.filter(item => item.type === "skill").every(item => !item.installedName.startsWith("workflow-"))).toBe(true);
    const [converted] = await resolvePluginImports({ ...request, convertPluginSkills: true }, root);
    if (!converted) throw new Error("No converted plugin plan");
    if (!ordinary) throw new Error("No ordinary plugin plan");
    expect(converted.preview.id).toBe(ordinary.preview.id);
    const connectorName = ordinary.preview.components.find(item => item.type === "mcp")?.installedName;
    expect(converted.preview.components.find(item => item.type === "mcp")?.installedName).toBe(connectorName);
    if (!connectorName) throw new Error("Missing connector");
    const emptyTarget = { workspace: root, scope: "global", current: {} } satisfies Parameters<typeof preparePluginImport>[1];
    const probe = { fetch: async (_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });
    } } satisfies NonNullable<Parameters<typeof preparePluginImport>[2]>;
    const ordinaryReview = await preparePluginImport(ordinary, emptyTarget, probe);
    expect(() => reviewedPluginImport(converted, emptyTarget, ordinaryReview.preview.validationId)).toThrow("review");
    await installPluginImport(config, "test", root, ordinaryReview, true);
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => ({ ...current, mcp: { [connectorName]: { type: "remote", url: "https://docs.example/mcp", enabled: false, headers: { Authorization: "Bearer saved-fixture-key" } } } }));
    const original = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[ordinary.preview.id];
    const target = { ...emptyTarget, installed: original, current: (await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp ?? {} };
    const prepared = await preparePluginImport(converted, target, probe);
    const reviewed = reviewedPluginImport(converted, target, prepared.preview.validationId);
    const workflows = reviewed.preview.components.filter(item => item.type === "skill");
    expect(workflows).toHaveLength(2);
    expect(workflows.every(item => item.installedName.startsWith("workflow-assistant-"))).toBe(true);
    expect(reviewed.preview.components.filter(item => item.type !== "skill").map(item => item.type).sort()).toEqual(["agent", "command", "mcp"]);
    expect(reviewed.preview.components.filter(item => item.type !== "skill").every(item => !item.installedName.startsWith("workflow-"))).toBe(true);
    await installPluginImport(config, "test", root, reviewed, true);
    const [installed] = Object.values((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins);
    expect(installed?.sourceKind).toBe("plugin");
    expect(installed?.provenance?.asWorkflow).toBe(true);
    expect(installed?.provenance?.convertPluginSkills).toBe(true);
    expect(installed?.files.filter(file => file.objectType === "mcp")).toHaveLength(1);
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.[connectorName]).toMatchObject({ headers: { Authorization: "Bearer saved-fixture-key" } });
    const checklist = reviewed.resourceFiles.find(file => file.path.endsWith("/references/checklist.md") && file.path.includes("/skills/"));
    if (!checklist) throw new Error("Missing workflow supporting file");
    expect(await readFile(resolveWorkspaceInstallPath(root, checklist.path, true), "utf8")).toBe("Check the document's main provisions.");
    await writeFile(join(source, "skills/review/SKILL.md"), `${skill}\nExplain the revised findings.`);
    const [updated] = await resolvePluginImports({ ...request, asWorkflow: installed?.provenance?.asWorkflow, convertPluginSkills: installed?.provenance?.convertPluginSkills }, root);
    if (!updated) throw new Error("Missing update plan");
    expect(updated.preview.id).toBe(reviewed.preview.id);
    expect(updated.preview.components.filter(item => item.type === "skill").map(item => item.installedName)).toEqual(workflows.map(item => item.installedName));
    const refreshed = await preparePluginImport(updated, { ...target, installed, current: (await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp ?? {} }, probe);
    await installPluginImport(config, "test", root, refreshed, true);
    expect(Object.values((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins)).toHaveLength(1);
  }));
}

for (const provider of ["claude", "chatgpt"] satisfies Array<"claude" | "chatgpt">) {
  test(`${provider} converts only selected skill paths and binds review, installation and rollback to that selection`, () => fixture(async (root, config) => {
    const source = join(root, "selective-kit");
    await files(source, {
      [provider === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json"]: '{"name":"selective-kit"}',
      "skills/contracts/SKILL.md": skill,
      "skills/contracts/references/checklist.md": "Check the contracts.",
      "skills/evidence/SKILL.md": skill,
      "agents/reviewer.md": "Review evidence.",
    });
    const request = { source: { provider, path: source }, scope: "global", asWorkflow: true, workflowSkillsOnly: true } satisfies Parameters<typeof resolvePluginImports>[0];
    const [ordinary] = await resolvePluginImports(request, root);
    const [selected] = await resolvePluginImports({ ...request, workflowSkillPaths: ["skills/contracts/SKILL.md"] }, root);
    const [different] = await resolvePluginImports({ ...request, workflowSkillPaths: ["skills/evidence/SKILL.md"] }, root);
    const [none] = await resolvePluginImports({ ...request, workflowSkillPaths: [] }, root);
    if (!ordinary || !selected || !different || !none) throw new Error("Missing selection plans");
    for (const item of [selected, different, none]) expect(item.preview.id).toBe(ordinary.preview.id);
    expect(selected.preview.digest).toBe(different.preview.digest);
    expect(selected.preview.components.filter(item => item.asWorkflow)).toMatchObject([{ sourcePath: "skills/contracts/SKILL.md" }]);
    expect(selected.preview.components.find(item => item.sourcePath === "skills/evidence/SKILL.md")?.asWorkflow).toBe(false);
    expect(selected.preview.components.filter(item => item.type === "agent")).toHaveLength(1);
    expect(none.preview.components.some(item => item.asWorkflow)).toBe(false);
    expect(none.preview.provenance?.workflowSkillPaths).toEqual([]);
    const target = { workspace: root, scope: "global", current: {} } satisfies Parameters<typeof preparePluginImport>[1];
    await installPluginImport(config, "test", root, await preparePluginImport(ordinary, target), true);
    const original = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[ordinary.preview.id];
    const reviewed = await preparePluginImport(selected, { ...target, installed: original });
    expect(() => reviewedPluginImport(different, { ...target, installed: original }, reviewed.preview.validationId)).toThrow("review");
    expect(() => reviewedPluginImport(none, { ...target, installed: original }, reviewed.preview.validationId)).toThrow("review");
    await installPluginImport(config, "test", root, reviewed, true);
    const installed = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[selected.preview.id];
    expect(installed?.provenance?.workflowSkillPaths).toEqual(["skills/contracts/SKILL.md"]);
    expect(installed?.files.filter(item => item.objectType === "skill" && item.title.startsWith("workflow-assistant-"))).toHaveLength(1);
    for (const component of selected.resolved.memberships) {
      const path = component.configObject?.currentRelativePath;
      if (path && component.configObject?.objectType === "skill") {
        const actual = parseFrontmatter(await readFile(resolveWorkspaceInstallPath(root, path, true), "utf8"));
        const expected = parseFrontmatter(component.configObject?.latestVersion?.rawSourceText ?? "");
        expect(actual.data).toEqual(expected.data);
        expect(actual.body.trim()).toBe(expected.body.trim());
      }
    }
    const converted = selected.preview.components.find(item => item.asWorkflow);
    const destination = selected.resolved.memberships.find(item => item.configObject?.title === converted?.installedName)?.configObject?.currentRelativePath;
    if (!destination) throw new Error("Missing converted skill");
    expect(await readFile(resolveWorkspaceInstallPath(root, join(dirname(destination), "references/checklist.md"), true), "utf8")).toBe("Check the contracts.");
    await rollbackPluginImport(config, "test", root, selected.preview.id, true);
    const restored = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[selected.preview.id];
    expect(restored?.provenance?.workflowSkillPaths).toBeUndefined();
    expect(restored?.files.some(item => item.title.startsWith("workflow-assistant-"))).toBe(false);
    expect(Object.keys((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins)).toHaveLength(1);
  }));
}

test("conversion selections normalize unique package paths and reject unsafe or malformed choices", () => {
  const request = { source: { provider: "claude", path: "/plugin" }, scope: "global" };
  expect(parsePluginImportRequest({ ...request, workflowSkillPaths: ["skills/z/SKILL.md", "./skills/a/SKILL.md", "skills/z/SKILL.md"] }).workflowSkillPaths).toEqual(["skills/a/SKILL.md", "skills/z/SKILL.md"]);
  expect(parsePluginImportRequest({ ...request, workflowSkillPaths: [] }).workflowSkillPaths).toEqual([]);
  for (const workflowSkillPaths of [["../SKILL.md"], ["/private/SKILL.md"], ["skills/../SKILL.md"], "all", [42]]) {
    expect(() => parsePluginImportRequest({ ...request, workflowSkillPaths })).toThrow();
  }
});

test("converted workflows with long similar names install as distinct skills", () => fixture(async (root, config) => {
  const source = join(root, "long-names");
  await files(source, {
    ".claude-plugin/plugin.json": '{"name":"document-review-collection"}',
    "skills/contracts/SKILL.md": "---\nname: document-review-contracts\n---\nReview contracts.",
    "skills/evidence/SKILL.md": "---\nname: document-review-evidence\n---\nReview evidence.",
  });
  const [converted] = await resolvePluginImports({ source: { provider: "claude", path: source }, scope: "global", convertPluginSkills: true }, root);
  if (!converted) throw new Error("Missing workflow plan");
  const names = converted.preview.components.map(item => item.installedName);
  expect(new Set(names).size).toBe(2);
  expect(names.every(name => name.startsWith("workflow-assistant-") && name.length <= 64)).toBe(true);
  await installPluginImport(config, "test", root, await preparePluginImport(converted, { workspace: root, scope: "global", current: {} }), true);
  const installed = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[converted.preview.id];
  expect(installed?.files.filter(file => file.objectType === "skill")).toHaveLength(2);
}));

test("the tracked update API retains explicit plugin-to-workflow conversion", () => fixture(async (root, config) => {
  const source = join(root, "review-kit");
  await files(source, { ".claude-plugin/plugin.json": '{"name":"review-kit"}', "skills/review/SKILL.md": skill });
  const request = { source: { provider: "claude", path: source }, scope: "global", asWorkflow: true, workflowSkillsOnly: true, convertPluginSkills: true, workflowSkillPaths: ["skills/review/SKILL.md"] } satisfies Parameters<typeof resolvePluginImports>[0];
  const [plan] = await resolvePluginImports(request, root);
  if (!plan) throw new Error("No workflow plan");
  const prepared = await preparePluginImport(plan, { workspace: root, scope: "global", current: {} });
  await installPluginImport(config, "test", root, prepared, true);
  await writeFile(join(source, "skills/review/SKILL.md"), `${skill}\nExplain the findings.`);
  await files(source, { "skills/new/SKILL.md": "---\nname: new-skill\n---\nNew skill." });
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}/workspace/test/plugin-imports`;
  const headers = { authorization: "Bearer client", "x-legalwork-host-token": "owner", "content-type": "application/json" };
  try {
    const response = await fetch(`${base}/${encodeURIComponent(plan.preview.id)}/update`, { headers });
    expect(response.status).toBe(200);
    const update: PluginImportUpdate = await response.json();
    expect(update).toMatchObject({ changed: true, asWorkflow: true, convertPluginSkills: true, preview: { id: plan.preview.id } });
    expect(update.workflowSkillPaths).toEqual(["skills/review/SKILL.md"]);
    expect(update.preview.components.find(item => item.sourcePath === "skills/review/SKILL.md")?.installedName).toStartWith("workflow-assistant-");
    expect(update.preview.components.find(item => item.sourcePath === "skills/new/SKILL.md")?.asWorkflow).toBe(false);
    const installed = await fetch(`${base}/install`, { method: "POST", headers, body: JSON.stringify({ source: update.source, scope: update.scope, root: update.root, digest: update.preview.digest, validationId: update.preview.validationId, asWorkflow: update.asWorkflow, convertPluginSkills: update.convertPluginSkills, workflowSkillPaths: update.workflowSkillPaths }) });
    expect(installed.status).toBe(200);
    expect(Object.values((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins)).toHaveLength(1);
  } finally { await server.stop(); }
}));

test("different publishers with the same name have independent identity while source edits retain identity", () => fixture(async root => {
  for (const folder of ["first", "second"]) await files(join(root, folder), { ".claude-plugin/plugin.json": '{"name":"review"}', "skills/review/SKILL.md": skill });
  const first = await plan(join(root, "first"), root); const second = await plan(join(root, "second"), root);
  const target = { workspace: root, scope: "project", current: {} } satisfies Parameters<typeof preparePluginImport>[1];
  const firstReview = await preparePluginImport(first, target); const secondReview = await preparePluginImport(second, target);
  expect(secondReview.preview.id).toBe(second.preview.id);
  expect(secondReview.preview.validationId).not.toBe(firstReview.preview.validationId);
  expect(() => reviewedPluginImport(second, target, firstReview.preview.validationId)).toThrow("review");
  expect(first.preview.id).not.toBe(second.preview.id);
  await writeFile(join(root, "first/skills/review/SKILL.md"), `${skill}\nUpdated.`);
  const changed = await plan(join(root, "first"), root);
  expect(changed.preview.id).toBe(first.preview.id); expect(changed.preview.digest).not.toBe(first.preview.digest);
}));

test("required dependencies and registered cloud apps cannot be installed as working plugins", () => fixture(async (root, config) => {
  const source = join(root, "dependency");
  await files(source, { ".claude-plugin/plugin.json": '{"name":"review","dependencies":[{"name":"missing","version":"^2.0.0"}]}', "skills/review/SKILL.md": skill });
  const pending = await preparePluginImport(await plan(source, root), { workspace: root, scope: "project", current: {}, available: [] });
  expect(pending.preview.readiness).toBe("unsupported"); expect(() => assertImportable(pending, true)).toThrow("missing");
  await expect(installPluginImport(config, "test", root, pending, false)).rejects.toThrow("missing");
  const available = { pluginId: "dependency", name: "missing", marketplaceId: null, description: null, updatedAt: null, files: [], importedAt: null, provenance: { provider: "claude", kind: "folder", location: source, root: "", digest: "source", version: "2.1.0" } } satisfies Parameters<typeof preparePluginImport>[1]["installed"];
  const checked = await preparePluginImport(await plan(source, root), { workspace: root, scope: "project", current: {}, available: [available] });
  expect(checked.preview.readiness).toBe("ready"); expect(checked.preview.requirements?.[0]?.status).toBe("satisfied");
  const app = { source: { provider: "chatgpt", zipBase64: Buffer.from(zipSync({ ".codex-plugin/plugin.json": strToU8('{"name":"app","apps":"./.app.json"}'), ".app.json": strToU8('{"apps":{"github":"plugin_asdk_app_example"}}'), "skills/review/SKILL.md": strToU8(skill) })).toString("base64") }, scope: "project" } satisfies Parameters<typeof resolvePluginImports>[0];
  const [appPlan] = await resolvePluginImports(app, root);
  expect(appPlan?.preview.readiness).toBe("unsupported"); expect(appPlan?.preview.requirements?.[0]?.kind).toBe("app");
}));

test("portable schema validation rejects unknown versions and isolates invalid connector documents", () => fixture(async root => {
  const source = join(root, "portable");
  await files(source, { "plugin.json": JSON.stringify({ $schema: schema.replace("1.0.0", "999.0.0"), name: "review" }), "skills/review/SKILL.md": skill });
  await expect(plan(source, root)).rejects.toThrow("unsupported schema");
  await writeFile(join(source, "plugin.json"), JSON.stringify({ $schema: schema, name: "review" }));
  await files(source, { "mcp.json": '{"mcpServers":{}}' });
  const checked = await plan(source, root);
  expect(checked.preview.components.map(item => item.type)).toEqual(["skill"]); expect(checked.preview.readiness).toBe("partial");
  expect(() => assertImportable(checked)).toThrow("confirm"); expect(() => assertImportable(checked, true)).not.toThrow();
}));

test("discovery skips trash, resolves canonical skill links and reports disabled install state", () => fixture(async root => {
  const home = join(root, "home"); const source = join(root, "canonical");
  await files(source, { "SKILL.md": skill }); await mkdir(join(home, ".claude/skills"), { recursive: true }); await symlink(source, join(home, ".claude/skills/review"));
  await files(join(home, ".claude/plugins/.trash/old"), { ".claude-plugin/plugin.json": '{"name":"removed"}' });
  const plugin = join(home, ".claude/plugins/cache/team/review/1");
  await files(plugin, { ".claude-plugin/plugin.json": '{"name":"review"}', "skills/review/SKILL.md": skill });
  await files(join(home, ".claude"), { "plugins/installed_plugins.json": JSON.stringify({ plugins: { "review@team": [{ installPath: plugin }] } }), "settings.json": '{"enabledPlugins":{"review@team":false}}' });
  const cached = join(home, ".claude/plugins/cache/other/review/1");
  await files(cached, { ".claude-plugin/plugin.json": '{"name":"review"}', "skills/review/SKILL.md": skill });
  await files(join(home, ".claude/plugins/cache/synced/synced-plugin/1"), { ".claude-plugin/plugin.json": '{"name":"synced-plugin"}', "skills/review/SKILL.md": skill });
  const items = await discoverPluginImports("claude", root);
  expect(items.find(item => item.path === cached)?.state).toBe("available");
  expect(items.find(item => item.name === "synced-plugin")?.state).toBe("synced");
  expect(items.some(item => item.name === "removed")).toBe(false); const canonical = await realpath(source); expect(items.some(item => item.path === canonical)).toBe(true);
  expect(items.find(item => item.path === plugin)?.state).toBe("disabled");
}));

test("discovery hides unusable packages and bundled connectors while retaining usable parts for both providers", () => fixture(async root => {
  for (const provider of ["chatgpt", "claude"] satisfies Array<"chatgpt" | "claude">) {
    const plugins = join(root, provider === "chatgpt" ? ".agents/plugins" : ".claude/plugins");
    const manifest = provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
    await files(join(plugins, "contacts"), { [manifest]: '{"name":"contacts","apps":"./.app.json"}', ".app.json": '{"apps":{"contacts":"app_google_contacts"}}' });
    await files(join(plugins, "empty"), { [manifest]: '{"name":"empty"}', "README.md": "No runnable components." });
    await files(join(plugins, "unsupported"), { [manifest]: '{"name":"unsupported"}', ".mcp.json": '{"mcpServers":{"private":{"type":"sdk"}}}' });
    await files(join(plugins, "mixed"), { [manifest]: '{"name":"mixed"}', "skills/review/SKILL.md": skill, ".mcp.json": '{"mcpServers":{"private":{"type":"sdk"},"search":{"url":"https://search.example/mcp"}}}' });
    await files(join(plugins, "custom"), { [manifest]: '{"name":"custom","skills":"./custom-skills/"}', "custom-skills/review/SKILL.md": skill });
    const items = await discoverPluginImports(provider, root);
    const own = items.filter(item => item.path.startsWith(plugins));
    expect(own.filter(item => item.kind === "plugin").map(item => item.name).sort()).toEqual(["custom", "mixed"]);
    expect(own.filter(item => item.kind === "connector").map(item => item.name)).toEqual(["search"]);
    expect((await resolvePluginImports({ source: { provider, path: join(plugins, "mixed") }, scope: "project" }, root))[0]?.preview.readiness).toBe("partial");
  }
}));

test("Cowork plugin archives accept their native file extension", () => fixture(async root => {
  const path = join(root, "review.plugin");
  await writeFile(path, zipSync({ ".claude-plugin/plugin.json": strToU8('{"name":"review"}'), "skills/review/SKILL.md": strToU8(skill) }));
  expect((await plan(path, root)).preview.components).toHaveLength(1);
}));

test("generic file imports detect each package format and retain its provider identity", () => fixture(async root => {
  const entries = {
    "claude/.claude-plugin/plugin.json": '{"name":"review-claude"}',
    "claude/skills/review/SKILL.md": skill,
    "codex/.codex-plugin/plugin.json": '{"name":"review-codex"}',
    "codex/skills/review/SKILL.md": skill,
  };
  await files(root, entries);
  const source = { provider: "claude", zipBase64: Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([path, content]) => [path, strToU8(content)])))).toString("base64") };
  const request = parsePluginImportRequest({ source, scope: "global", detectFormat: true });
  const previews = (await resolvePluginImports(request, root)).map(plan => plan.preview);
  expect(previews.map(item => item.provenance?.provider)).toEqual(["claude", "chatgpt"]);
  expect(previews.map(item => item.format)).toEqual(["claude", "codex"]);
  expect(previews[1]?.id).toMatch(/^import:chatgpt:/);
}));

test("large document collections cannot bypass discovery compatibility checks", () => fixture(async root => {
  const plugins = join(root, ".agents/plugins");
  const documents = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`skills/review/references/${index}.md`, "Reference"]));
  await files(join(plugins, "portable"), { ".codex-plugin/plugin.json": '{"name":"portable"}', "skills/review/SKILL.md": skill, ...documents });
  await files(join(plugins, "hosted-only"), { ".codex-plugin/plugin.json": '{"name":"hosted-only","apps":"./.app.json"}', ".app.json": '{"apps":{"contacts":"app_contacts"}}', "skills/review/SKILL.md": skill, ...documents });
  await files(join(plugins, "malformed"), { ".codex-plugin/plugin.json": '{"name":"malformed","skills":"missing"}' });
  const items = (await discoverPluginImports("chatgpt", root)).filter(item => item.path.startsWith(plugins));
  expect(items.map(item => item.name)).toEqual(["portable"]);
}));

test("tracked updates preserve history and can restore complete files without overwriting local edits", () => fixture(async (root, config) => {
  const source = join(root, "source");
  await files(source, { ".claude-plugin/plugin.json": '{"name":"review","version":"1.0.0"}', "skills/review/SKILL.md": skill, "skills/review/references/checklist.md": "Version one" });
  const firstPlan = await plan(source, root);
  const first = await installPluginImport(config, "test", root, firstPlan, false);
  const data = resolveWorkspaceInstallPath(root, `${firstPlan.dataPaths![0]}/session.json`);
  await writeFile(data, "persistent user data");
  expect(first.history?.[0]?.action).toBe("installed");
  await files(source, { ".claude-plugin/plugin.json": '{"name":"review","version":"2.0.0"}', "skills/review/references/checklist.md": "Version two" });
  const second = await installPluginImport(config, "test", root, await plan(source, root), false);
  expect(second.snapshots).toHaveLength(1); expect(second.history?.map(item => item.action)).toEqual(["installed", "updated"]);
  const installedSkill = second.files.find(item => item.objectType === "skill"); if (!installedSkill) throw new Error("Missing skill");
  const reference = resolveWorkspaceInstallPath(root, `${dirname(installedSkill.path)}/references/checklist.md`);
  expect(await readFile(reference, "utf8")).toBe("Version two");
  await writeFile(reference, "Local changes");
  await expect(rollbackPluginImport(config, "test", root, second.pluginId, false)).rejects.toThrow("local changes");
  expect(await readFile(reference, "utf8")).toBe("Local changes");
  await writeFile(reference, "Version two");
  // A damaged backup must leave the entire current installation intact.
  const snapshotFile = resolveWorkspaceInstallPath(root, `${second.snapshots![0]}/snapshot.json`);
  const snapshotText = await readFile(snapshotFile, "utf8");
  const snapshot: { locations: Array<{ location: string; backup: string | null }> } = JSON.parse(snapshotText);
  snapshot.locations[1].backup = `${second.snapshots![0]}/missing`;
  await writeFile(snapshotFile, JSON.stringify(snapshot));
  await expect(rollbackPluginImport(config, "test", root, second.pluginId, false)).rejects.toThrow();
  expect(await readFile(reference, "utf8")).toBe("Version two");
  expect((await readInstalledCloudPlugins(config, "test")).plugins[first.pluginId]?.provenance?.version).toBe("2.0.0");
  await writeFile(snapshotFile, snapshotText);
  const restored = await rollbackPluginImport(config, "test", root, second.pluginId, false);
  expect(await readFile(data, "utf8")).toBe("persistent user data");
  expect(await readFile(reference, "utf8")).toBe("Version one"); expect(restored.provenance?.version).toBe("1.0.0");
  expect((await readInstalledCloudPlugins(config, "test")).plugins[first.pluginId]?.history?.at(-1)?.action).toBe("rolled_back");
}));

test("review tokens bind dependency state even for skill-only packages", () => fixture(async root => {
  const source = join(root, "source"); await files(source, { ".claude-plugin/plugin.json": '{"name":"review"}', "skills/review/SKILL.md": skill });
  const pending = await plan(source, root); const target = { workspace: root, scope: "project", current: {} } satisfies Parameters<typeof preparePluginImport>[1];
  expect(() => reviewedPluginImport(pending, target)).toThrow("review expired");
  const checked = await preparePluginImport(pending, target);
  expect(reviewedPluginImport(pending, target, checked.preview.validationId).preview.readiness).toBe("ready");
}));


test("portable connectors isolate invalid entries and reserve persistent environment variables", () => fixture(async root => {
  const source = join(root, "portable");
  await files(source, { "plugin.json": JSON.stringify({ $schema: schema, name: "review.tools", author: { email: "team@example.com" }, extensions: false }), "skills/review/SKILL.md": skill, "mcp.json": JSON.stringify({ $schema: schema.replace("plugin.schema", "mcp.schema"), mcpServers: { valid: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/run.js"], cwd: "${PLUGIN_DATA}" }, invalid: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/other" } }, badArgs: { type: "stdio", command: "node", args: "run.js" }, notObject: true, sse: { type: "sse", url: "https://example.com/sse" } } }) });
  const checked = await plan(source, root);
  expect(checked.preview.components.filter(item => item.type === "mcp").map(item => item.name)).toEqual(["valid"]);
  expect(checked.preview.connectors?.filter(item => item.status === "blocked")).toHaveLength(4);
  const config = checked.connectorConfigs?.[checked.preview.components.find(item => item.type === "mcp")!.installedName];
  expect(config?.env).toMatchObject({ PLUGIN_ROOT: expect.stringContaining("imported-plugins"), PLUGIN_DATA: expect.stringContaining("plugin-data") });
}));


test("real bundled manifest shapes allow absent optional skills directories and expose unsupported source hosts", () => fixture(async root => {
  const source = join(root, "host-plugin");
  await files(source, { ".codex-plugin/plugin.json": JSON.stringify({ name: "host-plugin", skills: "./skills/", mcpServers: "./.mcp.json" }), ".mcp.json": JSON.stringify({ mcpServers: { desktop: { command: "node", args: ["server.mjs"], env_vars: ["CODEX_APP_TOOLS_PIPE_PATH"] } } }) });
  const [checked] = await resolvePluginImports({ source: { provider: "chatgpt", path: source }, scope: "project" }, root);
  expect(checked?.preview.readiness).toBe("unsupported");
  expect(checked?.preview.connectors?.[0]).toMatchObject({ status: "blocked", code: "source_runtime" });
  expect(checked?.preview.components).toEqual([]);
}));

test("connector tool approval rules are blocked before normalization can widen access", () => fixture(async root => {
  const source = join(root, "policy-plugin");
  await files(source, { ".claude-plugin/plugin.json": '{"name":"policy-plugin"}', ".mcp.json": JSON.stringify({ mcpServers: { restricted: { url: "https://example.com/mcp", enabled_tools: ["read"] }, approvals: { url: "https://example.com/mcp", tools: { write: { approval_mode: "prompt" } } } } }) });
  const checked = await plan(source, root);
  expect(checked.preview.connectors?.every(item => item.status === "blocked" && item.code === "tool_policy")).toBe(true);
  expect(checked.preview.readiness).toBe("unsupported");
}));

test("source-app setup commands and private artifact runtimes never appear ready", () => fixture(async root => {
  const source = join(root, "runtime-plugin");
  await files(source, { ".claude-plugin/plugin.json": '{"name":"runtime-plugin"}', "commands/setup.md": "---\ndescription: Configure the original app\n---\nRun `claude mcp add --transport http service https://example.com/mcp`.", "skills/deck/SKILL.md": "---\nname: deck\ndescription: Create slides\n---\nAuthor with `@oai/artifact-tool`." });
  const checked = await plan(source, root);
  expect(checked.preview.requirements?.map(item => item.code).sort()).toEqual(["source_app_setup", "source_runtime"]);
  expect(checked.preview.readiness).toBe("unsupported");
  expect(() => assertImportable(checked, true)).toThrow();
}));
