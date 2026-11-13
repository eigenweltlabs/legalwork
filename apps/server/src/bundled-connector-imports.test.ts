import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverPluginImports, parsePluginImportRequest, resolvePluginImports } from "./plugin-imports.js";
import { installPluginImport } from "./plugin-import-install.js";
import { removeCloudPlugin } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { PluginImportProvider } from "@legalwork/types/plugin-import";
import type { ServerConfig } from "./types.js";

async function fixture(action: (root: string, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-bundled-connector-"));
  const previous = new Map(["LEGALWORK_PLUGIN_DISCOVERY_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "LEGALWORK_RUNTIME_DB", "XDG_CONFIG_HOME"].map(key => [key, process.env[key]]));
  process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = root;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "global");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  try { await action(root, config); } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}
async function write(path: string, content: unknown, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), { mode });
}
const selectedRequest = (provider: PluginImportProvider, path: string, name: string, pluginRoot = "") => parsePluginImportRequest({ source: { provider, path, connector: { name, pluginRoot } }, scope: "global" });

test("discovers individual bundled connectors for both providers alongside standalone connectors without exposing configuration", async () => fixture(async root => {
  for (const provider of ["chatgpt", "claude"] satisfies PluginImportProvider[]) {
    const source = join(root, provider === "chatgpt" ? ".codex/plugins/patent" : ".claude/plugins/patent");
    const manifest = { name: "patent", version: "1.10", interface: { displayName: "Patent Studio" }, mcpServers: ["./config/search.json", { search: { url: "https://override.example/mcp", headers: { Secret: "selected-secret" } } }] };
    if (provider === "chatgpt") {
      await write(join(source, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "patent", version: "1.10", extensions: { "com.openai": manifest } });
      await write(join(source, ".codex-plugin/plugin.json"), { name: "legacy-overlay", mcpServers: { ignored: { url: "https://ignored.example" } } });
    } else await write(join(source, ".claude-plugin/plugin.json"), manifest);
    await write(join(source, provider === "chatgpt" ? "mcp.json" : ".mcp.json"), { ...(provider === "chatgpt" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" } : {}), mcpServers: { search: { type: "streamable-http", url: "https://default.example" }, local: { type: "stdio", command: "./bin/server" }, sdk: { type: "sdk" } } });
    await write(join(source, "config/search.json"), { ...(provider === "chatgpt" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" } : {}), mcpServers: { second: { type: "streamable-http", url: "https://second.example/mcp", headers: { Secret: "other-secret" } } } });
    // Discovery needs no access to executable assets; preview validates the complete folder.
    await symlink(join(root, "unavailable"), join(source, "linked-asset"));
    if (provider === "chatgpt") await write(join(root, ".codex/config.toml"), '[mcp_servers.search]\nurl = "https://standalone.example/mcp"\n');
    else await write(join(root, ".claude.json"), { mcpServers: { search: { url: "https://standalone.example/mcp" } } });
    const items = await discoverPluginImports(provider, root);
    const connectors = items.filter(item => item.kind === "connector");
    expect(connectors.filter(item => item.bundledIn).map(item => item.name).sort()).toEqual(["local", "search", "second"]);
    expect(connectors.filter(item => item.name === "search")).toHaveLength(2);
    expect(connectors.find(item => item.bundledIn)?.bundledIn).toEqual({ name: "patent", displayName: "Patent Studio" });
    expect(connectors.find(item => item.bundledIn)?.connector?.pluginRoot).toBe("");
    expect(items.find(item => item.kind === "plugin")?.displayName).toBe("Patent Studio");
    expect(JSON.stringify(items)).not.toMatch(/selected-secret|other-secret|override\.example|standalone\.example/);
  }
}));

test("selected bundled imports use effective MCP precedence and exclude other connectors, credentials and skills", async () => fixture(async root => {
  for (const provider of ["chatgpt", "claude"] satisfies PluginImportProvider[]) {
    const source = join(root, provider);
    await write(join(source, provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json"), { name: "patent", interface: { displayName: "Patent Studio" }, mcpServers: ["config/mcp.json", { search: { url: "https://override.example/mcp", headers: { Key: "selected-key" } } }] });
    await write(join(source, ".mcp.json"), { mcpServers: { search: { url: "https://default.example/mcp" }, private: { url: "https://private.example/mcp", headers: { Key: "unselected-secret" } } } });
    await write(join(source, "config/mcp.json"), { mcpServers: { second: { url: "https://second.example/mcp", headers: { Key: "second-secret" } } } });
    await write(join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview claims.");
    const [plan] = await resolvePluginImports(selectedRequest(provider, source, "search"), root);
    expect(plan!.preview.components.map(component => [component.type, component.name])).toEqual([["mcp", "search"]]);
    expect(plan!.preview.format).toBe("connectors");
    expect(plan!.preview.warnings).toEqual([]);
    expect(plan!.resolved.plugin.sourceKind).toBe("connector");
    expect(plan!.resolved.plugin.displayName).toBe("Search");
    const text = JSON.stringify(plan!.resolved);
    expect(text).toContain("https://override.example/mcp");
    expect(text).toContain('"enabled":false');
    expect(text).not.toContain("default.example");
    const resources = plan!.resourceFiles.map(file => Buffer.from(file.bytes).toString()).join("\n");
    expect(resources).toContain("selected-key");
    expect(resources).not.toMatch(/unselected-secret|second-secret|Review claims/);
  }
}));

test("local bundled connectors retain executable support files and resolve paths into an independent installed bundle", async () => fixture(async (root, config) => {
  const source = join(root, "plugin");
  await write(join(source, ".claude-plugin/plugin.json"), { name: "patent", mcpServers: "config/mcp.json" });
  await write(join(source, "config/mcp.json"), { mcpServers: { local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["./scripts/run.js"], env: { REFERENCE: "${PLUGIN_ROOT}/assets/data.txt" } }, private: { url: "https://other.example/mcp", headers: { Key: "unselected-secret" } } } });
  await write(join(source, "bin/server"), "#!/bin/sh\nexit 0\n", 0o755);
  await write(join(source, "scripts/run.js"), "console.log('server')");
  await write(join(source, "assets/data.txt"), "support data");
  await write(join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\nReference.");
  const [plan] = await resolvePluginImports(selectedRequest("claude", source, "local"), root);
  expect(plan!.preview.components.map(component => component.type)).toEqual(["mcp"]);
  expect(plan!.resolved.memberships.map(item => item.configObject?.objectType)).toEqual(["mcp"]);
  expect(plan!.resourceFiles.find(file => file.path.endsWith("bin/server"))?.mode).toBe(0o755);
  expect(plan!.resourceFiles.some(file => file.path.endsWith("config/mcp.json"))).toBe(false);
  expect(plan!.resourceFiles.map(file => Buffer.from(file.bytes).toString()).join("\n")).not.toContain("unselected-secret");
  await installPluginImport(config, "test", root, plan!, true);
  const installedName = plan!.preview.components[0]!.installedName;
  const installed = (await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[installedName];
  expect(installed?.type).toBe("local");
  if (installed?.type !== "local") throw new Error("Expected local MCP connector");
  if (!Array.isArray(installed.command)) throw new Error("Expected a local command array");
  const [executable, argument] = installed.command;
  if (typeof executable !== "string" || typeof argument !== "string") throw new Error("Expected packaged executable and script paths");
  expect(executable).toContain("/imported-plugins/");
  expect(argument).toContain("/imported-plugins/");
  expect(executable).not.toContain(source);
  expect((await stat(executable)).mode & 0o777).toBe(0o755);
  expect(await readFile(argument, "utf8")).toBe("console.log('server')");
}));

test("full plugin, individually selected connectors and version updates have independent install/remove ownership", async () => fixture(async (root, config) => {
  const source = join(root, "plugin");
  for (const [path, version] of [[source, "1.0"]]) {
    await write(join(path!, ".claude-plugin/plugin.json"), { name: "patent", version });
    await write(join(path!, ".mcp.json"), { mcpServers: { search: { url: `https://v${version}.example/mcp` }, docket: { url: "https://docket.example/mcp" } } });
  }
  const [whole] = await resolvePluginImports({ source: { provider: "claude", path: source }, scope: "global" }, root);
  const [search] = await resolvePluginImports(selectedRequest("claude", source, "search"), root);
  const [docket] = await resolvePluginImports(selectedRequest("claude", source, "docket"), root);
  for (const plan of [whole!, search!, docket!]) await installPluginImport(config, "test", root, plan, true);
  expect(new Set([whole!.preview.id, search!.preview.id, docket!.preview.id]).size).toBe(3);
  await write(join(source, ".claude-plugin/plugin.json"), { name: "patent", version: "2.0" });
  await write(join(source, ".mcp.json"), { mcpServers: { search: { url: "https://v2.0.example/mcp" }, docket: { url: "https://docket.example/mcp" } } });
  const [updated] = await resolvePluginImports(selectedRequest("claude", source, "search"), root);
  expect(updated!.preview.id).toBe(search!.preview.id);
  expect(updated!.preview.digest).not.toBe(search!.preview.digest);
  expect(updated!.preview.components[0]!.installedName).toBe(search!.preview.components[0]!.installedName);
  await installPluginImport(config, "test", root, updated!, true);
  const searchName = updated!.preview.components[0]!.installedName;
  expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[searchName]).toMatchObject({ url: "https://v2.0.example/mcp", disabled: true });
  await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: updated!.preview.id, scope: "global" });
  const runtime = await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID);
  expect(runtime.mcp?.servers?.[searchName]).toBeUndefined();
  for (const component of [...whole!.preview.components, ...docket!.preview.components]) expect(runtime.mcp?.servers?.[component.installedName]).toBeDefined();
}));

test("bundled selectors validate roots, missing connectors and links without hiding other discoveries", async () => fixture(async root => {
  const source = join(root, "collection");
  const pluginRoot = "export/patent";
  await write(join(source, pluginRoot, ".claude-plugin/plugin.json"), { name: "patent", mcpServers: { search: { url: "https://search.example/mcp" } } });
  const request = selectedRequest("claude", source, "search", pluginRoot);
  const [plan] = await resolvePluginImports(request, root);
  expect(plan!.preview.root).toBe(pluginRoot);
  await expect(resolvePluginImports({ ...request, root: "other" }, root)).rejects.toThrow("root");
  await expect(resolvePluginImports(selectedRequest("claude", source, "search", "missing"), root)).rejects.toThrow("root");
  await expect(resolvePluginImports(selectedRequest("claude", source, "__proto__", pluginRoot), root)).rejects.toThrow("no longer");
  expect(() => selectedRequest("claude", source, "search", "../escape")).toThrow("Unsafe");
  expect(() => parsePluginImportRequest({ source: { provider: "claude", path: source, connector: { name: "search", pluginRoot: "", project: root } }, scope: "global" })).toThrow("either");
  const broken = join(root, ".claude/plugins/broken");
  await write(join(broken, ".claude-plugin/plugin.json"), { name: "broken", mcpServers: "config/mcp.json" });
  await mkdir(join(root, "outside"));
  await write(join(root, "outside/mcp.json"), { mcpServers: { hidden: { url: "https://hidden.example/mcp" } } });
  await symlink(join(root, "outside"), join(broken, "config"));
  const valid = join(root, ".claude/plugins/valid");
  await write(join(valid, ".claude-plugin/plugin.json"), { name: "valid", mcpServers: { visible: { url: "https://visible.example/mcp" } } });
  const items = await discoverPluginImports("claude", root);
  expect(items.filter(item => item.kind === "connector").map(item => item.name)).toEqual(["visible"]);
  expect(items.some(item => item.name === "broken" && item.kind === "plugin")).toBe(false);
  await expect(resolvePluginImports(selectedRequest("claude", broken, "hidden"), root)).rejects.toThrow("link");
}));
