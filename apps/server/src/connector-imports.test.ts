import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverConnectorImports, normalizeImportedConnector } from "./connector-imports.js";
import { discoverPluginImports, parsePluginImportRequest, resolvePluginImports } from "./plugin-imports.js";
import { installPluginImport } from "./plugin-import-install.js";
import { removeCloudPlugin } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-connector-import-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function write(path: string, config: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof config === "string" ? config : JSON.stringify(config));
}

test("Context7 automatic OAuth keeps one canonical callback host while preserving supplied setup", () => {
  const url = "https://mcp.context7.com/mcp?client=claude-code-plugin";
  expect(normalizeImportedConnector({ url }, [])).toEqual({ url, oauth: { redirectUri: "http://localhost:19876/mcp/oauth/callback" } });
  expect(normalizeImportedConnector({ url, oauth: { callback_port: 3210, scope: "profile" } }, []).oauth).toEqual({ callbackPort: 3210, scope: "profile", redirectUri: "http://localhost:3210/mcp/oauth/callback" });
  expect(normalizeImportedConnector({ url: "https://mcp.context7.com/mcp/oauth" }, []).oauth).toEqual({ redirectUri: "http://localhost:19876/mcp/oauth/callback" });
  expect(normalizeImportedConnector({ url, oauth: { clientId: "registered-client" } }, []).oauth).toEqual({ clientId: "registered-client" });
  expect(normalizeImportedConnector({ url, oauth: { callback_url: "http://127.0.0.1:4321/registered" } }, []).oauth).toEqual({ redirectUri: "http://127.0.0.1:4321/registered" });
  expect(normalizeImportedConnector({ url, oauth: false }, []).oauth).toBe(false);
  expect(normalizeImportedConnector({ url, headers: { Authorization: "Bearer ${TOKEN}" } }, []).oauth).toBe(false);
  expect(normalizeImportedConnector({ url: "https://mcp.context7.com.example/mcp" }, []).oauth).toBeUndefined();
  expect(normalizeImportedConnector({ url: "https://${HOST}/mcp" }, []).oauth).toBeUndefined();
});

test("discovers individual Claude user, local-project, project and Desktop connectors without returning credentials", async () => fixture(async home => {
  const workspace = join(home, "project");
  const configPath = join(home, ".claude.json");
  await write(configPath, { accountToken: "never-export", mcpServers: { search: { command: "node", args: ["search.js"], env: { TOKEN: "private-key" } } }, projects: {
    [workspace]: { mcpServers: { search: { type: "http", url: "https://project.example/mcp" } } },
    [join(home, "other")]: { mcpServers: { literature: { type: "http", url: "https://literature.example/mcp" } } },
  } });
  await write(join(workspace, ".mcp.json"), { mcpServers: { docket: { type: "http", url: "https://docket.example/mcp" } } });
  await write(join(home, "other/.mcp.json"), { mcpServers: { otherProject: { type: "http", url: "https://other.example/mcp" } } });
  await write(join(home, "Library/Application Support/Claude/claude_desktop_config.json"), { mcpServers: { desktop: { command: "npx", args: ["server"] } } });
  const items = await discoverConnectorImports("claude", workspace, home, join(home, ".codex"), join(home, ".claude"));
  expect(items).toHaveLength(6);
  expect(items.filter(item => item.name === "search")).toHaveLength(2);
  expect(items.find(item => item.name === "literature")?.connector?.project).toBe(join(home, "other"));
  expect(items.find(item => item.name === "desktop")?.description).toBe("Claude Desktop");
  expect(JSON.stringify(items)).not.toContain("private-key");
  expect(JSON.stringify(items)).not.toContain("never-export");
  const req = parsePluginImportRequest({ source: { provider: "claude", path: configPath, connector: { name: "search", project: workspace } }, scope: "global" });
  const [plan] = await resolvePluginImports(req, workspace);
  expect(plan!.preview.components.map(item => item.name)).toEqual(["search"]);
  expect(JSON.stringify(plan!.resolved)).toContain("https://project.example/mcp");
  expect(JSON.stringify(plan!.resourceFiles.map(file => Buffer.from(file.bytes).toString()))).not.toContain("private-key");
}));

test("discovers custom Codex config and current-project TOML alongside existing plugins", async () => fixture(async home => {
  const previous = new Map(["LEGALWORK_PLUGIN_DISCOVERY_HOME", "CODEX_HOME"].map(key => [key, process.env[key]]));
  const codex = join(home, "custom-codex");
  const workspace = join(home, "project");
  const knownProject = join(home, "other-project");
  try {
    process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = home;
    process.env.CODEX_HOME = codex;
    await write(join(codex, "config.toml"), `[projects.${JSON.stringify(knownProject)}]\ntrust_level = "trusted"\n[mcp_servers.patent_search]\ncommand = "node"\nargs = ["search.js"]\n[mcp_servers.patent_search.env]\nKEY = "keep-local"\n`);
    await write(join(workspace, ".codex/config.toml"), '[mcp_servers.literature]\nurl = "https://literature.example/mcp"\n');
    await write(join(knownProject, ".codex/config.toml"), '[mcp_servers.docket]\nurl = "https://docket.example/mcp"\n');
    await write(join(codex, "plugins/patent/.codex-plugin/plugin.json"), { name: "patent" });
    await write(join(codex, "plugins/patent/skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview.");
    const items = await discoverPluginImports("chatgpt", workspace);
    expect(items.map(item => item.name).sort()).toEqual(["docket", "literature", "patent", "patent_search"]);
    expect(items.filter(item => item.kind === "connector")).toHaveLength(3);
    expect(JSON.stringify(items)).not.toContain("keep-local");
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}));

test("identical remote connectors across Claude and Codex projects appear once without project labels", async () => fixture(async home => {
  const workspace = join(home, "legalwork");
  const projects = [workspace, join(home, "old/legalwork"), join(home, "yavio"), join(home, "knowledge-index")];
  const remote = { url: "https://linear.example/mcp", headers: { Region: "eu", Authorization: "Bearer private-token" } };
  await write(join(home, ".claude.json"), { projects: Object.fromEntries(projects.map(project => [project, { mcpServers: { linear: remote } }])) });
  await write(join(workspace, ".mcp.json"), { mcpServers: { linear: { headers: { Authorization: "Bearer private-token", Region: "eu" }, url: remote.url } } });
  const codex = join(home, "codex");
  await write(join(codex, "config.toml"), projects.map(project => `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"`).join("\n"));
  for (const project of projects) await write(join(project, ".codex/config.toml"), '[mcp_servers.linear]\nurl = "https://linear.example/mcp"\nhttp_headers = { Authorization = "Bearer private-token", Region = "eu" }\n');
  for (const provider of ["claude", "chatgpt"] satisfies Array<"claude" | "chatgpt">) {
    const items = await discoverConnectorImports(provider, workspace, home, codex, join(home, ".claude"));
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe(provider === "claude" ? "Claude Code" : "Codex");
    expect(JSON.stringify(items)).not.toContain("private-token");
  }
}));

test("deduplication retains different credentials, endpoints and project-relative programs", async () => fixture(async home => {
  const workspace = join(home, "project");
  const other = join(home, "other");
  const remote = { url: "https://linear.example/mcp", headers: { Authorization: "Bearer first-secret" } };
  const local = { command: "node", args: ["server.js"] };
  await write(join(home, ".claude.json"), { mcpServers: { linear: remote }, projects: {
    [workspace]: { mcpServers: { linear: { ...remote, headers: { Authorization: "Bearer second-secret" } }, local } },
    [other]: { mcpServers: { linear: { ...remote, url: "https://other.example/mcp" }, local } },
  } });
  const items = await discoverConnectorImports("claude", workspace, home, join(home, ".codex"), join(home, ".claude"));
  expect(items.filter(item => item.name === "linear")).toHaveLength(3);
  expect(items.filter(item => item.name === "local")).toHaveLength(2);
  expect(JSON.stringify(items)).not.toMatch(/first-secret|second-secret|enabled_tools/);
}));

test("discovery hides unsupported source runtimes, permission rules and missing programs without hiding credential setup", async () => fixture(async home => {
  const workspace = join(home, "project");
  await write(join(home, ".claude.json"), { mcpServers: {
    hosted: { url: "https://mcp.figma.com/mcp" },
    session: { url: "https://example.com/mcp", auth: "chatgpt" },
    policy: { url: "https://example.com/mcp", disabled_tools: ["delete"] },
    missing: { command: join(home, "missing-program") },
    setup: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    local: { command: process.execPath, args: ["server.js"] },
  } });
  const items = await discoverConnectorImports("claude", workspace, home, join(home, ".codex"), join(home, ".claude"));
  expect(items.map(item => item.name).sort()).toEqual(["local", "setup"]);
}));

test("Codex callback settings remain part of the imported connector identity", async () => fixture(async home => {
  const workspace = join(home, "project");
  const codex = join(home, "codex");
  for (const [path, port] of [[join(codex, "config.toml"), 1111], [join(workspace, ".codex/config.toml"), 2222]]) {
    await write(String(path), `mcp_oauth_callback_port = ${port}\n[mcp_servers.linear]\nurl = "https://linear.example/mcp"\n`);
  }
  const items = await discoverConnectorImports("chatgpt", workspace, home, codex, join(home, ".claude"));
  expect(items).toHaveLength(2);
}));

test("maps Codex environment and HTTP authentication fields without reading environment secrets", async () => fixture(async root => {
  const configPath = join(root, "config.toml");
  await write(configPath, '[mcp_servers.search]\nurl = "https://search.example/mcp"\nbearer_token_env_var = "IMPORT_TOKEN"\ntool_timeout_sec = 30\nhttp_headers = { "X-Region" = "eu" }\nenv_http_headers = { "X-Key" = "IMPORT_KEY" }\n[mcp_servers.search.oauth]\nclient_id = "registered-client"\n[mcp_servers.local]\ncommand = "node"\nargs = ["server.js", "argument with spaces"]\nenv_vars = ["IMPORT_TOKEN"]\n[mcp_servers.local.env]\nFIXED = "literal"\n');
  const request = { source: { provider: "chatgpt", path: configPath, connector: { name: "search" } }, scope: "global" } satisfies Parameters<typeof resolvePluginImports>[0];
  const [remote] = await resolvePluginImports(request, root);
  const text = JSON.stringify(remote!.resolved);
  expect(text).toContain('"Authorization":"Bearer ${IMPORT_TOKEN}"');
  expect(text).toContain('"X-Key":"${IMPORT_KEY}"');
  expect(text).toContain('"X-Region":"eu"');
  expect(text).toContain('"clientId":"registered-client"');
  expect(text).toContain('"enabled":false');
  expect(remote!.preview.format).toBe("connectors");
  expect(remote!.resolved.plugin.sourceKind).toBe("connector");
  expect(remote!.preview.connectors?.[0]?.status).not.toBe("blocked");
  const [local] = await resolvePluginImports({ ...request, source: { ...request.source, connector: { name: "local" } } }, root);
  expect(JSON.stringify(local!.resolved)).toContain('"args":["server.js","argument with spaces"]');
  expect(JSON.stringify(local!.resolved)).toContain('"IMPORT_TOKEN":"${IMPORT_TOKEN}"');
  expect(JSON.stringify(local!.resolved)).toContain('"FIXED":"literal"');
}));

test("ordinary connector setup has no compatibility warning, while unsupported account and permission behavior does", async () => fixture(async root => {
  const path = join(root, "config.toml");
  await write(path, '[mcp_servers.github]\nurl = "https://github.example/mcp"\nbearer_token_env_var = "GITHUB_TOKEN"\nstartup_timeout_sec = 20\ntool_timeout_sec = 60\n[mcp_servers.github.oauth]\nclient_id = "client"\ncallback_port = 4000\ncallback_url = "http://localhost:4000/callback"\n[mcp_servers.bound]\nurl = "https://bound.example/mcp"\nauth = "chatgpt"\ndisabled_tools = ["delete"]\ndefault_tools_approval_mode = "never"\n');
  const [setup] = await resolvePluginImports({ source: { provider: "chatgpt", path, connector: { name: "github" } }, scope: "global" }, root);
  expect(setup!.preview.warnings).toEqual([]);
  expect(JSON.stringify(setup!.resolved)).toContain('"enabled":false');
  expect(JSON.stringify(setup!.resolved)).toContain('"Authorization":"Bearer ${GITHUB_TOKEN}"');
  const [bound] = await resolvePluginImports({ source: { provider: "chatgpt", path, connector: { name: "bound" } }, scope: "global" }, root);
  expect(bound!.preview.warnings).toEqual([
    "Codex tool restrictions and approval rules will not carry over. LegalWork's tool permissions apply instead.",
  ]);
  expect(bound!.preview.connectors?.[0]).toMatchObject({ status: "blocked", code: "platform_session" });
  expect(bound!.preview.components).toEqual([]);
}));

test("imports only a selected connector, replaces it, prunes its old entry and removes it globally", async () => fixture(async root => {
  const previous = new Map(["LEGALWORK_RUNTIME_DB", "XDG_CONFIG_HOME"].map(key => [key, process.env[key]]));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "global");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  const sourcePath = join(root, ".claude.json");
  const req = parsePluginImportRequest({ source: { provider: "claude", path: sourcePath, connector: { name: "docket" } }, scope: "global" });
  try {
    await write(sourcePath, { account: "do-not-copy", mcpServers: { docket: { url: "https://docket.example/mcp", headers: { "X-Key": "selected-key" } }, private: { url: "https://other.example/mcp", headers: { "X-Key": "other-key" } } } });
    const [before] = await resolvePluginImports(req, root);
    const originalText = await readFile(sourcePath, "utf8");
    const resources = before!.resourceFiles.map(file => Buffer.from(file.bytes).toString()).join("\n");
    expect(resources).toContain("selected-key");
    expect(resources).not.toContain("other-key");
    expect(resources).not.toContain("do-not-copy");
    await installPluginImport(config, "test", root, before!, true);
    expect(await readFile(sourcePath, "utf8")).toBe(originalText);
    const installedName = before!.preview.components[0]!.installedName;
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[installedName]).toMatchObject({ url: "https://docket.example/mcp", disabled: true, headers: { "X-Key": "selected-key" } });
    await write(sourcePath, { mcpServers: { docket: { command: "node", args: ["new.js"], env: { FIXED: "value" } } } });
    const [after] = await resolvePluginImports(req, root);
    expect(after!.preview.id).toBe(before!.preview.id);
    expect(after!.preview.digest).not.toBe(before!.preview.digest);
    expect(after!.preview.components[0]!.installedName).toBe(installedName);
    await installPluginImport(config, "test", root, after!, true);
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[installedName]).toMatchObject({ type: "local", command: ["node", "new.js"], disabled: true });
    await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: after!.preview.id, scope: "global" });
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.[installedName]).toBeUndefined();
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}));

test("malformed configurations and links do not hide valid sources, and missing selectors cannot access inherited properties", async () => fixture(async home => {
  const workspace = join(home, "project");
  await write(join(home, ".claude.json"), "{malformed");
  await write(join(workspace, ".mcp.json"), { mcpServers: { valid: { url: "https://example.com/mcp" } } });
  const linked = join(home, ".claude/.claude.json");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(join(workspace, ".mcp.json"), linked);
  expect((await discoverConnectorImports("claude", workspace, home, join(home, ".codex"), join(home, ".claude"))).map(item => item.name)).toEqual(["valid"]);
  const request = { source: { provider: "claude", path: linked, connector: { name: "valid" } }, scope: "global" } satisfies Parameters<typeof resolvePluginImports>[0];
  await expect(resolvePluginImports(request, workspace)).rejects.toThrow("Could not read");
  await expect(resolvePluginImports({ ...request, source: { ...request.source, path: join(workspace, ".mcp.json"), connector: { name: "__proto__" } } }, workspace)).rejects.toThrow("no longer");
  expect(() => parsePluginImportRequest({ source: { provider: "claude", zipBase64: "UEs=", connector: { name: "valid" } }, scope: "global" })).toThrow();
}));
