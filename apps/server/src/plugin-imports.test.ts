import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { discoverPluginImports, parsePluginImportRequest, resolvePluginImports } from "./plugin-imports.js";
import { installPluginImport } from "./plugin-import-install.js";
import { pluginNamespace, readInstalledCloudPlugins, removeCloudPlugin } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import { runtimeMcpMapForWorkspace } from "./mcp.js";
import type { PluginImportRequest } from "@legalwork/types/plugin-import";
import type { ServerConfig } from "./types.js";

const skill = "---\nname: search\ndescription: Patent search\nmetadata:\n  jurisdiction: EU\n---\nRead [guide](./references/guide.md). Run ${CLAUDE_PLUGIN_ROOT}/bin/tool and ${CLAUDE_SKILL_DIR}/scripts/run.py.\n";
const fixtures = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "patent", version: "1.0.0", skills: ["./extra-skills/"], mcpServers: ["./config/mcp.json", { remote: { url: "https://override.example/mcp" } }], hooks: "./hooks/hooks.json" }),
  ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://default.example/mcp" }, local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/tool", args: ["./server.js"], env: { API_KEY: "${PATENT_KEY}" } } } }),
  "config/mcp.json": JSON.stringify({ mcpServers: { second: { url: "https://second.example/mcp" } } }),
  "skills/search/SKILL.md": skill,
  "skills/search/references/guide.md": "Reference data",
  "skills/search/scripts/run.py": "print('hello')",
  "extra-skills/review/SKILL.md": "---\nname: review\ndescription: Review a claim\n---\nReview.",
  "agents/examiner.md": "---\nname: examiner\ndescription: Patent examiner\nmodel: sonnet\n---\nExamine.",
  "commands/run.md": "---\ndescription: Start workflow\nagent: examiner\n---\nUse patent:search.",
  "hooks/hooks.json": "{\"hooks\":{}}",
  "bin/tool": "#!/bin/sh\necho ok\n",
  "server.js": "console.log('server')",
  "assets/icon.png": new Uint8Array([0, 255, 128, 0, 80]),
  "README.md": "Plugin readme",
};
type FixtureFiles = Record<string, string | Uint8Array>;
function archive(files: FixtureFiles, prefix = ""): string { return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [`${prefix}${path}`, typeof value === "string" ? strToU8(value) : value])))).toString("base64"); }
function request(files: FixtureFiles = fixtures): PluginImportRequest { return { source: { provider: "claude", zipBase64: archive(files, "export/patent/") }, scope: "project" }; }
async function temp(fn: (root: string, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-plugin-import-"));
  const previous = { db: process.env.LEGALWORK_RUNTIME_DB, xdg: process.env.XDG_CONFIG_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "global");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "config.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  try { await fn(root, config); } finally {
    for (const [key, value] of [["LEGALWORK_RUNTIME_DB", previous.db], ["XDG_CONFIG_HOME", previous.xdg], ["CLAUDE_CONFIG_DIR", previous.claude]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
    await rm(root, { recursive: true, force: true });
  }
}
async function writeFixture(root: string, files: FixtureFiles) { for (const [path, value] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value, { mode: path === "bin/tool" ? 0o755 : 0o600 }); } }

describe("complete plugin imports", () => {
  test("reads wrapped Claude ZIPs, supplemental skills, agents, commands and MCP precedence", async () => {
    const [plan] = await resolvePluginImports(request(), "/project");
    expect(plan!.preview.root).toBe("export/patent");
    expect(plan!.preview.components.map(c => c.type).sort()).toEqual(["agent", "command", "mcp", "mcp", "mcp", "skill", "skill"]);
    expect(plan!.preview.fileCount).toBe(Object.keys(fixtures).length);
    const mcp = plan!.resolved.memberships.find(m => m.configObject?.objectType === "mcp")?.configObject?.latestVersion?.normalizedPayloadJson;
    expect(JSON.stringify(mcp)).toContain("override.example");
    expect(JSON.stringify(mcp)).not.toContain("default.example");
    expect(plan!.preview.warnings.join(" ")).toContain("hooks");
    expect(plan!.preview.warnings.join(" ")).toContain("imported disabled");
    expect(plan!.resourceFiles.some(file => file.path.endsWith("assets/icon.png") && file.bytes[1] === 255)).toBe(true);
    const content = plan!.resolved.memberships.find(m => m.configObject?.objectType === "command")?.configObject?.latestVersion?.rawSourceText;
    expect(content).not.toContain("patent:search");
    expect(content).toContain(plan!.preview.components.find(c => c.type === "agent")!.installedName);
  });
  test("imports Codex legacy nested skills plus inline connectors and source assets", async () => {
    const files = { ".codex-plugin/plugin.json": JSON.stringify({ name: "legal-tools", skills: "./nested/skills", mcpServers: "./.mcp.json", apps: "./.app.json" }), "nested/skills/claim/SKILL.md": skill, ".mcp.json": '{"mcpServers":{"search":{"url":"https://search.example/mcp"}}}', ".app.json": '{"apps":{"app":"plugin_asdk_app_1"}}', "scripts/shared.py": "shared" };
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", zipBase64: archive(files) }, scope: "project" }, "/project");
    expect(plan!.preview.format).toBe("codex");
    expect(plan!.preview.components.map(c => c.type)).toEqual(["skill", "mcp"]);
    expect(plan!.preview.warnings.join(" ")).toContain("provider app IDs");
    expect(plan!.resourceFiles.some(f => f.path.endsWith("scripts/shared.py"))).toBe(true);
  });
  test("portable metadata stays canonical and inline OpenAI extension replaces legacy overlay", async () => {
    const files = { "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "canonical", version: "2", extensions: { "com.openai": { apps: "./.app.json" } } }), ".codex-plugin/plugin.json": '{"name":"legacy","version":"1","mcpServers":"./missing.json"}', "skills/search/SKILL.md": skill, "mcp.json": JSON.stringify({ mcpServers: { public: { type: "streamable-http", url: "https://public.example/mcp", extensions: { "com.openai": { auth: { type: "none" } } } }, private: { url: "https://private.example/mcp", extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "provided", clientId: "client" }, baseScopes: ["read"] } } } } } }) };
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", zipBase64: archive(files) }, scope: "project" }, "/project");
    expect(plan!.preview.name).toBe("canonical"); expect(plan!.preview.version).toBe("2"); expect(plan!.preview.format).toBe("portable");
    expect(JSON.stringify(plan!.resolved)).toContain('"oauth":false'); expect(JSON.stringify(plan!.resolved)).toContain('"clientId":"client"');
  });
  test("supports manifest-free skill collections and inline command definitions", async () => {
    const [collection] = await resolvePluginImports(request({ "one/SKILL.md": skill, "two/SKILL.md": skill.replace("name: search", "name: second") }), "/project");
    expect(collection!.preview.components).toHaveLength(2);
    const [inline] = await resolvePluginImports(request({ ".claude-plugin/plugin.json": '{"name":"inline","commands":{"about":{"content":"Explain the plugin.","description":"About"}}}' }), "/project");
    expect(inline!.preview.components).toHaveLength(1); expect(JSON.stringify(inline!.resolved)).toContain("Explain the plugin.");
  });
  test("installs full folder with executable and binary assets, preserved metadata and complete uninstall", async () => temp(async (root, config) => {
    const source = join(root, "source"); await writeFixture(source, fixtures);
    const req: PluginImportRequest = { source: { provider: "claude", path: source }, scope: "project" };
    const [plan] = await resolvePluginImports(req, root);
    const installed = await installPluginImport(config, "test", root, plan!, false);
    const ns = pluginNamespace("patent", plan!.preview.id);
    expect(await readFile(join(root, ".opencode/imported-plugins", ns, "assets/icon.png"))).toEqual(Buffer.from(fixtures["assets/icon.png"]));
    expect((await stat(join(root, ".opencode/imported-plugins", ns, "bin/tool"))).mode & 0o111).toBe(0o111);
    const skillPath = installed.files.find(f => f.objectType === "skill")!.path;
    expect(await readFile(join(root, skillPath), "utf8")).toContain("jurisdiction: EU");
    expect(await readFile(join(root, dirname(skillPath), "references/guide.md"), "utf8")).toBe("Reference data");
    expect((await readInstalledCloudPlugins(config, "test")).plugins[plan!.preview.id]).toBeDefined();
    await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: plan!.preview.id });
    await expect(stat(join(root, ".opencode/imported-plugins", ns))).rejects.toThrow();
    await expect(stat(join(root, skillPath))).rejects.toThrow();
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {})).toHaveLength(0);
  }));
  test("global imports are visible in other project engines and can be removed there", async () => temp(async (root, config) => {
    const [plan] = await resolvePluginImports({ ...request(), scope: "global" }, root);
    const installed = await installPluginImport(config, "test", root, plan!, true);
    expect(installed.scope).toBe("global");
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "another-project"))).toHaveLength(3);
    const ns = pluginNamespace("patent", plan!.preview.id);
    const path = join(root, "global/opencode/skills", ns, plan!.preview.components.find(c => c.type === "skill")!.installedName, "SKILL.md");
    expect(await readFile(path, "utf8")).toContain("Patent search");
    await removeCloudPlugin({ serverConfig: config, workspaceId: "another-project", workspaceRoot: root, pluginId: plan!.preview.id });
    expect(Object.keys((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins)).toHaveLength(0);
    await expect(stat(path)).rejects.toThrow();
  }));
  test("preserves exact MCP arguments, empty environment values and headers", async () => temp(async (root, config) => {
    const files = { ".claude-plugin/plugin.json": '{"name":"arguments"}', ".mcp.json": JSON.stringify({ mcpServers: { local: { command: "node", args: ["script.js", "", "  a b  "], env: { EMPTY: "", PADDED: "  value  " } }, remote: { url: "https://example.com/mcp", headers: { "X-Value": "  value  " } } } }), "script.js": "console.log('test')" };
    const [plan] = await resolvePluginImports(request(files), root);
    await installPluginImport(config, "test", root, plan!, false);
    const values = Object.values((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {});
    const local = values.find(value => value.type === "local");
    expect(local?.command).toEqual(["node", expect.stringContaining("script.js"), "", "  a b  "]);
    expect(local?.environment).toMatchObject({ EMPTY: "", PADDED: "  value  " });
    expect(values.find(value => value.type === "remote")?.headers).toEqual({ "X-Value": "  value  " });
  }));
  test("the same package in global and project scopes keeps independent components and connectors", async () => temp(async (root, config) => {
    const [projectPlan] = await resolvePluginImports(request(), root);
    const [globalPlan] = await resolvePluginImports({ ...request(), scope: "global" }, root);
    await installPluginImport(config, "test", root, projectPlan!, false);
    await installPluginImport(config, "test", root, globalPlan!, true);
    expect(projectPlan!.preview.id).not.toBe(globalPlan!.preview.id);
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "test"))).toHaveLength(6);
    await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: projectPlan!.preview.id, scope: "workspace" });
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "test"))).toHaveLength(3);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[globalPlan!.preview.id]).toBeDefined();
    await expect(removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: globalPlan!.preview.id, scope: "workspace" })).rejects.toThrow();
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "test"))).toHaveLength(3);
  }));
  test("updates prune removed skills, connectors and old resources", async () => temp(async (root, config) => {
    const [original] = await resolvePluginImports(request(), root); await installPluginImport(config, "test", root, original!, false);
    const ns = pluginNamespace("patent", original!.preview.id);
    const files = { ".claude-plugin/plugin.json": '{"name":"patent"}', "skills/new/SKILL.md": skill.replace("name: search", "name: new") };
    const [replacement] = await resolvePluginImports(request(files), root); await installPluginImport(config, "test", root, replacement!, false);
    await expect(stat(join(root, ".opencode/imported-plugins", ns, "server.js"))).rejects.toThrow();
    await expect(stat(join(root, ".opencode/skills", ns, original!.preview.components.find(c => c.type === "skill")!.installedName))).rejects.toThrow();
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {})).toHaveLength(0);
  }));
  test("a failed connector install restores the previous files and config", async () => temp(async (root, config) => {
    const [original] = await resolvePluginImports(request(), root); await installPluginImport(config, "test", root, original!, false);
    const before = await readRuntimeOpencodeConfig(config, "test");
    const [broken] = await resolvePluginImports(request({ ".claude-plugin/plugin.json": '{"name":"patent"}', ".mcp.json": '{"mcpServers":{"bad":{"url":"file:///invalid"}}}', "skills/changed/SKILL.md": skill }), root);
    await expect(installPluginImport(config, "test", root, broken!, false)).rejects.toThrow();
    const ns = pluginNamespace("patent", original!.preview.id);
    expect(await readFile(join(root, ".opencode/imported-plugins", ns, "server.js"), "utf8")).toBe("console.log('server')");
    expect((await readRuntimeOpencodeConfig(config, "test")).mcp).toEqual(before.mcp);
    expect((await readInstalledCloudPlugins(config, "test")).plugins[original!.preview.id]!.files.map(f => f.path)).toContain(original!.resourceFiles[0]!.path.split("/").slice(0, 3).join("/"));
  }));
  test("rejects source/destination links, traversal, duplicate/case paths and oversized archives", async () => temp(async (root, config) => {
    const source = join(root, "source"); await writeFixture(source, { "SKILL.md": skill }); await symlink(join(source, "SKILL.md"), join(source, "linked.md"));
    await expect(resolvePluginImports({ source: { provider: "claude", path: source }, scope: "project" }, root)).rejects.toThrow("link");
    await expect(resolvePluginImports(request({ "../escape/SKILL.md": skill }), root)).rejects.toThrow("Unsafe");
    await expect(resolvePluginImports(request({ "SKILL.md": skill, "skill.md": "collision" }), root)).rejects.toThrow("Duplicate");
    await expect(resolvePluginImports(request({ "SKILL.md": skill, "huge.bin": new Uint8Array(65 * 1024 * 1024) }), root)).rejects.toThrow("64 MB");
    const [plan] = await resolvePluginImports(request(), root); const ns = pluginNamespace("patent", plan!.preview.id);
    await mkdir(join(root, ".opencode/imported-plugins"), { recursive: true }); await symlink(source, join(root, ".opencode/imported-plugins", ns));
    await expect(installPluginImport(config, "test", root, plan!, false)).rejects.toThrow("linked");
    expect(Object.keys((await readInstalledCloudPlugins(config, "test")).plugins)).toHaveLength(0);
  }));
  test("folder changes invalidate the preview digest and discovery finds installed cache roots", async () => temp(async root => {
    const source = join(root, "claude/plugins/cache/patent/1.0"); await writeFixture(source, fixtures);
    const discovered = await discoverPluginImports("claude", root); expect(discovered.some(c => c.path === source)).toBe(true);
    const req: PluginImportRequest = { source: { provider: "claude", path: source }, scope: "project" };
    const [before] = await resolvePluginImports(req, root); await writeFile(join(source, "README.md"), "Changed");
    const [after] = await resolvePluginImports(req, root); expect(after!.preview.digest).not.toBe(before!.preview.digest);
  }));
  test("recognizes root manifests without optional fields and rejects using the wrong provider", async () => {
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", zipBase64: archive({ "plugin.json": '{"name":"plain"}', "skills/search/SKILL.md": skill, "mcp.json": '{"mcpServers":{"remote":{"url":"https://example.com/mcp"}}}' }) }, scope: "project" }, "/project");
    expect(plan!.preview.components).toHaveLength(2);
    await expect(resolvePluginImports({ ...request(), source: { provider: "chatgpt", zipBase64: archive(fixtures) } }, "/project")).rejects.toThrow("matching import button");
  });
  test("validates mutually exclusive import source fields", () => {
    expect(() => parsePluginImportRequest({ source: { provider: "claude", path: "/tmp", zipBase64: "UEs=" }, scope: "project" })).toThrow();
    expect(() => parsePluginImportRequest({ source: { provider: "other", path: "/tmp" }, scope: "project" })).toThrow();
  });
});


test("import API previews, enforces ownership, rejects stale sources and manages global packages across projects", async () => temp(async (root, config) => {
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  config.workspaces[0]!.baseUrl = `http://127.0.0.1:${engine.port}`;
  config.workspaces.push({ ...config.workspaces[0]!, id: "second", name: "Second" });
  const server = await startServer(config);
  const source = join(root, "source"); await writeFixture(source, { ".codex-plugin/plugin.json": '{"name":"api-plugin"}', "skills/one/SKILL.md": skill, "assets/data.bin": new Uint8Array([3, 2, 1]) });
  const base = `http://127.0.0.1:${server.port}/workspace/test`;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  const ownerHeaders = { ...headers, "X-LegalWork-Host-Token": "host" };
  const payload = { source: { provider: "chatgpt", path: source }, scope: "global" };
  try {
    const denied = await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(denied.status).toBe(401);
    const preview = await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(payload) });
    expect(preview.status).toBe(200);
    const result = await preview.json();
    const reviewed = result.items[0];
    const noReview = await fetch(`${base}/plugin-imports/install`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(payload) });
    expect(noReview.status).toBe(409);
    await writeFile(join(source, "assets/data.bin"), new Uint8Array([4, 5]));
    const stale = await fetch(`${base}/plugin-imports/install`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ...payload, root: reviewed.root, digest: reviewed.digest }) });
    expect(stale.status).toBe(409);
    const fresh = await (await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(payload) })).json();
    const imported = await fetch(`${base}/plugin-imports/install`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ...payload, root: fresh.items[0].root, digest: fresh.items[0].digest }) });
    expect(imported.status).toBe(200);
    const installed = await imported.json();
    expect(installed.item.scope).toBe("global");
    const skills = await (await fetch(`${base}/skills?includeGlobal=true`, { headers })).json();
    expect(skills.items.some((item: { name: string }) => item.name === fresh.items[0].components[0].installedName)).toBe(true);
    const otherBase = `http://127.0.0.1:${server.port}/workspace/second`;
    const listing = await (await fetch(`${otherBase}/cloud-plugins`, { headers })).json();
    expect(listing.plugins[installed.item.pluginId].scope).toBe("global");
    const removal = `${otherBase}/cloud-plugins/${encodeURIComponent(installed.item.pluginId)}`;
    expect((await fetch(removal, { method: "DELETE", headers })).status).toBe(401);
    expect((await fetch(removal, { method: "DELETE", headers: ownerHeaders })).status).toBe(200);
    const zippedPayload = { source: { provider: "claude", zipBase64: archive({ "SKILL.md": skill }) }, scope: "project" };
    const projectPreview = await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers, body: JSON.stringify(zippedPayload) });
    expect(projectPreview.status).toBe(200);
    const project = await projectPreview.json();
    expect((await fetch(`${base}/plugin-imports/install`, { method: "POST", headers, body: JSON.stringify({ ...zippedPayload, root: project.items[0].root, digest: project.items[0].digest }) })).status).toBe(200);
  } finally { await server.stop(); engine.stop(true); }
}), 30000);
