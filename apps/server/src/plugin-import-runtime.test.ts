import type { NativeMcpDefinition } from "./native-mcp-config.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePluginImports } from "./plugin-imports.js";
import { installPluginImport } from "./plugin-import-install.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { setMcpEnabled } from "./mcp.js";
import { listCommands } from "./commands.js";
import type { ServerConfig } from "./types.js";
import { startServer } from "./server.js";
import { writeInstalledCloudPlugins } from "./cloud-plugins.js";
import { runtimeMcpMapForWorkspace } from "./mcp.js";

async function fixture(run: (root: string, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "plugin-runtime-test-"));
  const previous = { db: process.env.LEGALWORK_RUNTIME_DB, xdg: process.env.XDG_CONFIG_HOME };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  try { await run(root, config); } finally {
    if (previous.db === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous.db;
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg;
    await rm(root, { recursive: true, force: true });
  }
}
async function plan(root: string, files: Record<string, string>, provider: "claude" | "chatgpt" = "claude") {
  const source = join(root, "source");
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), content); }
  const [result] = await resolvePluginImports({ source: { provider, path: source }, scope: "global" }, root);
  if (!result) throw new Error("Missing fixture plan");
  return result;
}

test("a Claude Context7 import installs the canonical OAuth callback into the engine configuration", async () => fixture(async (root, config) => {
  const url = "https://mcp.context7.com/mcp?client=claude-code-plugin";
  const imported = await plan(root, { ".claude-plugin/plugin.json": '{"name":"context7"}', ".mcp.json": JSON.stringify({ mcpServers: { context7: { type: "http", url } } }) });
  await installPluginImport(config, "test", root, imported, true);
  const entries = Object.values(await runtimeMcpMapForWorkspace(config, "test"));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "remote", url, oauth: { redirect_uri: "http://localhost:19876/mcp/oauth/callback" } });
}));
test("plugin runtime retains Codex headers, token requirements, callback URL and launch settings", () => fixture(async (root, config) => {
  const imported = await plan(root, {
    ".codex-plugin/plugin.json": '{"name":"runtime"}',
    ".mcp.json": JSON.stringify({ mcpServers: {
      token: { url: "https://example.invalid/mcp", http_headers: { "X-Tenant": "tenant" }, bearer_token_env_var: "PLUGIN_TOKEN", startup_timeout_sec: 25 },
      oauth: { url: "https://oauth.invalid/mcp", oauth: { clientId: "client", callbackUrl: "http://127.0.0.1:4321/callback/registered", callbackPort: 4321 } },
      local: { command: "node", args: ["./server.js"], cwd: "${PLUGIN_ROOT}", timeout: 45000, env_vars: ["PLUGIN_SECRET"] },
    } }),
    "server.js": "console.log('fixture')",
  }, "chatgpt");
  await installPluginImport(config, "test", root, imported, true);
  const runtime = (await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers ?? {};
  const get = (name: string) => runtime[imported.preview.components.find(item => item.name === name)!.installedName];
  expect(get("token")).toMatchObject({ headers: { "X-Tenant": "tenant", Authorization: "Bearer ${PLUGIN_TOKEN}" }, oauth: false, timeout: { startup: 25000, catalog: 25000, execution: 25000 }, disabled: true });
  const oauth = get("oauth");
  if (oauth?.type !== "remote") throw new Error("Missing remote OAuth fixture");
  expect(oauth.oauth).toEqual({ client_id: "client", redirect_uri: "http://127.0.0.1:4321/callback/registered", callback_port: 4321 });
  expect(get("local")).toMatchObject({ cwd: expect.stringContaining("imported-plugins/runtime-"), timeout: { startup: 45000, catalog: 45000, execution: 45000 }, environment: { PLUGIN_SECRET: "${PLUGIN_SECRET}" } });
}));
test("templated endpoints remain editable but unresolved credentials cannot be activated", () => fixture(async (root, config) => {
  const imported = await plan(root, { ".claude-plugin/plugin.json": '{"name":"tenant"}', ".mcp.json": JSON.stringify({ mcpServers: { tenant: { url: "https://${TENANT}.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } } }) });
  await installPluginImport(config, "test", root, imported, true);
  const name = imported.preview.components[0]!.installedName;
  const saved = (await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[name];
  if (saved?.type !== "remote") throw new Error("Missing remote connector fixture");
  expect(saved.url).toBe("https://${TENANT}.example.com/mcp");
  expect(await setMcpEnabled(config, "test", name, true)).toBe(false);
}));
test("commands refer to the engine's folder-qualified agent identity and remain listable", () => fixture(async (root, config) => {
  const imported = await plan(root, { ".claude-plugin/plugin.json": '{"name":"review"}', "agents/reviewer.md": "---\nname: reviewer\ndescription: Review\n---\nReview.", "commands/review.md": "---\ndescription: Review\nagent: reviewer\n---\nReview $ARGUMENTS." });
  const installed = await installPluginImport(config, "test", root, imported, true);
  const agent = installed.files.find(item => item.objectType === "agent")!;
  const command = installed.files.find(item => item.objectType === "command")!;
  const engineAgentName = agent.path.replace(/^\.opencode\/agents\//, "").replace(/\.md$/, "");
  const content = await readFile(join(root, "config/opencode", command.path.replace(/^\.opencode\//, "")), "utf8");
  expect(content).toContain(`agent: ${engineAgentName}`);
  expect((await listCommands(root, "global")).some(item => item.agent === engineAgentName)).toBe(true);
}));
test("re-import keeps user setup while updating untouched defaults and prevents credentials following a new endpoint", () => fixture(async (root, config) => {
  const files = { ".claude-plugin/plugin.json": '{"name":"updates"}', ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}", "X-Version": "1" } } } }) };
  const original = await plan(root, files);
  await installPluginImport(config, "test", root, original, true);
  const name = original.preview.components[0]!.installedName;
  await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => {
    const saved = current.mcp?.servers?.[name];
    if (saved?.type !== "remote") throw new Error("Missing remote connector fixture");
    return { ...current, mcp: { servers: { ...current.mcp?.servers, [name]: { ...saved, disabled: false, headers: { Authorization: "Bearer synthetic-user-token", "X-Version": "1" } } } } };
  });
  const update = await plan(root, { ...files, ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}", "X-Version": "2" }, timeout: 45000 } } }) });
  await installPluginImport(config, "test", root, update, true);
  expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[name]).toMatchObject({ disabled: false, timeout: { startup: 45000, catalog: 45000, execution: 45000 }, headers: { Authorization: "Bearer synthetic-user-token", "X-Version": "2" } });
  const changed = await plan(root, { ...files, ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://different.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } } }) });
  await installPluginImport(config, "test", root, changed, true);
  expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[name]).toMatchObject({ disabled: true, headers: { Authorization: "Bearer ${TOKEN}" } });
}));

test("configuration API updates the connector in its owned scope and cannot recreate a removed item", () => fixture(async (root, config) => {
  await plan(root, { ".claude-plugin/plugin.json": '{"name":"owned"}', ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } } }) });
  const [project] = await resolvePluginImports({ source: { provider: "claude", path: join(root, "source") }, scope: "project" }, root);
  if (!project) throw new Error("Missing project import");
  await installPluginImport(config, "test", root, project, false);
  const name = project.preview.components[0]!.installedName;
  const server = await startServer(config);
  const headers = { Authorization: "Bearer test", "X-LegalWork-Host-Token": "host", "Content-Type": "application/json" };
  try {
    const endpoint = `http://127.0.0.1:${server.port}/workspace/test/mcp`;
    const connection = { type: "remote", url: "https://example.invalid/mcp", oauth: false, disabled: false, headers: { Authorization: "Bearer synthetic-token" } } satisfies NativeMcpDefinition;
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ name, config: connection, preserveScope: true }) })).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(config, "test")).mcp?.servers?.[name]).toEqual(connection);
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[name]).toBeUndefined();
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ name: "removed", config: connection, preserveScope: true }) })).status).toBe(404);
  } finally { await server.stop(); }
}));

test("upgrading an older import recovers dropped launch fields while retaining completed credentials", () => fixture(async (root, config) => {
  const imported = await plan(root, { ".claude-plugin/plugin.json": '{"name":"legacy"}', ".mcp.json": JSON.stringify({ mcpServers: { local: { command: "node", args: ["server.js"], cwd: "${PLUGIN_ROOT}", timeout: 45000, env: { KEY: "${KEY}" } } } }), "server.js": "console.log('fixture')" });
  await installPluginImport(config, "test", root, imported, true);
  const name = imported.preview.components[0]!.installedName;
  await writeInstalledCloudPlugins(config, GLOBAL_MCP_ID, current => {
    const old = current.plugins[imported.preview.id]!;
    const { connectorDefaults, ...legacy } = old;
    return { ...current, plugins: { ...current.plugins, [imported.preview.id]: legacy } };
  });
  await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => {
    const saved = current.mcp?.servers?.[name];
    if (saved?.type !== "local") throw new Error("Missing local connector fixture");
    const { cwd, timeout, ...old } = saved;
    return { ...current, mcp: { servers: { ...current.mcp?.servers, [name]: { ...old, disabled: false, environment: { KEY: "synthetic-user-key" } } } } };
  });
  await installPluginImport(config, "test", root, imported, true);
  expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[name]).toMatchObject({ disabled: false, cwd: expect.stringContaining("imported-plugins/legacy-"), timeout: { startup: 45000, catalog: 45000, execution: 45000 }, environment: { KEY: "synthetic-user-key" } });
}));

test("old already-enabled imports cannot send unresolved credentials or a dummy endpoint to the engine", () => fixture(async (root, config) => {
  await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: {
    old: { type: "remote", url: "https://example.invalid/mcp", disabled: false, headers: { Authorization: "Bearer ${TOKEN}" } },
    dummy: { type: "remote", url: "https://configure-before-connecting.invalid/mcp", disabled: false },
    ready: { type: "remote", url: "https://ready.invalid/mcp", disabled: false },
  } } }));
  const engine = await runtimeMcpMapForWorkspace(config, "test");
  expect(engine.old?.disabled).toBe(true);
  expect(engine.dummy?.disabled).toBe(true);
  expect(engine.ready?.disabled).toBe(false);
}));
