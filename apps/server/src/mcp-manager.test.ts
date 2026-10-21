import { closeTestRuntime, removeTestDirectory } from "./runtime.test-helpers.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { LocalMcpGateway } from "./mcp-gateway.js";
import { initializeMcpManager, McpConnectorManager, stopMcpManager } from "./mcp-manager.js";
import { addMcp, removeMcp, listMcp, runtimeMcpMapForWorkspace, setMcpEnabled } from "./mcp.js";
import { GLOBAL_MCP_ID, readGlobalMcpMap, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { importConnectorsIntoSharedRow } from "./mcp-shared-store.js";
import { OAuthVault, oauthVaultPath } from "./file-storage/oauth/vault.js";
import { connectorVault } from "./connectors/store.js";
import { McpManagerStore, type RemoteMcp } from "./mcp-manager-store.js";
import { hasOpencodeProcess, migrateLegacyMcpOAuth, retryLegacyMcpMigration, startLegacyMcpMigrationRetry } from "./mcp-migration.js";
import { startServer } from "./server.js";
import { McpRecovery } from "./mcp-recovery.js";
import { engineAccessToken } from "./legalmemory-fetch.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const statsSchema = z.object({ authorizationGrants: z.number(), refreshGrants: z.number(), rejectedRefreshGrants: z.number(), revokedFamilies: z.number(), refreshAttempts: z.number(), toolCalls: z.number(), cancelledCalls: z.number() });
const entrySchema = z.object({ url: z.string(), headers: z.record(z.string(), z.string()), oauth: z.literal(false) });
const name = "mock";
async function until(check: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) { if (await check().catch(() => false)) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("Missing port");
  return port;
}

export async function managedMcpFixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-managed-mcp-"));
  cleanups.push(() => removeTestDirectory(root));
  const workspaces = [{ id: "ws_a", path: join(root, "a") }, { id: "ws_b", path: join(root, "b") }];
  await Promise.all(workspaces.map(item => mkdir(item.path)));
  const providerPort = freePort();
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  const provider = spawn("node", [resolve(import.meta.dir, "../../../scripts/mock-oauth-mcp-server.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(providerPort), ISSUER: providerUrl, AUTO_APPROVE: "1", CLIENT_ID: "", CLIENT_SECRET: "",
      DYNAMIC_REGISTRATION: "1", ACCESS_TOKEN_TTL_SECONDS: "3600", ROTATE_REFRESH_TOKENS: "1", REFRESH_REUSE_REVOKES_FAMILY: "1", REFRESH_DELAY_MS: "100", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let providerError = "";
  provider.stderr?.on("data", chunk => { providerError = (providerError + chunk.toString()).slice(-8192); });
  cleanups.push(async () => {
    if (provider.exitCode !== null || provider.signalCode !== null) return;
    const stopped = new Promise<void>(done => provider.once("exit", () => done()));
    provider.kill("SIGKILL");
    await stopped;
  });
  await until(async () => {
    if (provider.exitCode !== null) throw new Error(`Provider exited (${provider.exitCode}): ${providerError}`);
    return z.object({ issuer: z.string() }).parse(await (await fetch(`${providerUrl}/health`, { signal: AbortSignal.timeout(1000) })).json()).issuer === providerUrl;
  }, `provider startup${providerError ? ": " + providerError : ""}`);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "app-only-token", hostToken: "host-only-token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [],
    workspaces: workspaces.map(item => ({ ...item, name: item.id, preset: "starter", workspaceType: "local" })), authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const manager = initializeMcpManager(config);
  cleanups.push(() => closeTestRuntime(config));
  cleanups.push(() => stopMcpManager(config));
  const gateway = new LocalMcpGateway(manager);
  cleanups.push(() => gateway.close());
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/mcp\/gateway\/([^/]+)\/([^/]+)$/);
    if (!match) return new Response(null, { status: 404 });
    try { return await gateway.handle(request, match[1], match[2]); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "failed" }, { status: 503 }); }
  } });
  config.port = listener.port ?? 0;
  cleanups.push(() => listener.stop(true));
  const settings = { type: "remote", url: `${providerUrl}/mcp`, enabled: true, oauth: {} };
  await addMcp(config, "ws_a", name, settings);
  const entries = async (workspaceId: string) => manager.engineEntries(workspaceId, await runtimeMcpMapForWorkspace(config, workspaceId));
  const gatewayEntry = async (workspaceId = "ws_a") => entrySchema.parse((await entries(workspaceId))[name]);
  const stats = async () => statsSchema.parse(await (await fetch(`${providerUrl}/stats`)).json());
  const signIn = async (workspaceId = "ws_a", connectionName = name) => {
    const start = await manager.startAuthorization(workspaceId, connectionName);
    const approval = await fetch(start.authorizationUrl, { redirect: "manual" });
    const redirect = approval.headers.get("location");
    if (!redirect) throw new Error("Provider did not approve sign-in");
    const callback = new URL(redirect);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Provider omitted code");
    await manager.finishAuthorization(workspaceId, connectionName, code, start.oauthState, callback.searchParams.get("iss") ?? undefined);
    return { code, state: start.oauthState };
  };
  const connect = async (workspaceId = "ws_a") => {
    const entry = await gatewayEntry(workspaceId);
    const client = new Client({ name: workspaceId, version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    return client;
  };
  const expire = () => fetch(`${providerUrl}/expire`, { method: "POST" });
  return { root, workspaces, config, manager, gateway, listener, providerUrl, settings, entries, gatewayEntry, signIn, stats, connect, expire };
}

describe("server-owned MCP connections", () => {
  test("MCP shares the existing OAuth vault and preserves other connectors during refresh and restart", async () => {
    const f = await managedMcpFixture();
    await stopMcpManager(f.config);
    const vault = new OAuthVault(oauthVaultPath(f.config));
    const grant = { accessToken: "existing-storage-access", refreshToken: "existing-storage-refresh", expiresAt: 123 };
    const capabilitySchema = z.object({ nangoConnectionId: z.string() });
    await vault.set("storage-signin", grant);
    await connectorVault(f.config).setEntry("nango-capability", capabilitySchema, { nangoConnectionId: "existing-nango-connection" });
    const key = process.env.LEGALWORK_ENCRYPTION_KEY ? undefined : await readFile(`${vault.path}.key`);
    const manager = initializeMcpManager(f.config);
    await manager.reconcile();
    expect(manager.store.path).toBe(vault.path);
    const start = await manager.startAuthorization("ws_a", name);
    const approval = await fetch(start.authorizationUrl, { redirect: "manual" });
    const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;
    await manager.finishAuthorization("ws_a", name, code, start.oauthState);
    const record = manager.store.all()[0]!;
    await f.expire();
    await Promise.all([
      manager.client(record).then(client => client.listTools()),
      vault.set("storage-signin", { ...grant, accessToken: "rotated-storage-access" }),
      connectorVault(f.config).setEntry("nango-capability", capabilitySchema, { nangoConnectionId: "updated-nango-connection" }),
    ]);
    expect((await f.stats()).refreshGrants).toBe(1);
    const tokens = manager.store.all()[0]?.tokens;
    await stopMcpManager(f.config);
    const restarted = initializeMcpManager(f.config);
    await restarted.reconcile();
    expect(restarted.store.all()[0]?.tokens).toEqual(tokens);
    expect(await vault.get("storage-signin")).toEqual({ ...grant, accessToken: "rotated-storage-access" });
    expect(await connectorVault(f.config).getEntry("nango-capability", capabilitySchema)).toEqual({ nangoConnectionId: "updated-nango-connection" });
    if (key) expect(await readFile(`${vault.path}.key`)).toEqual(key);
    if (process.platform !== "win32") expect((await stat(vault.path)).mode & 0o777).toBe(0o600);
    for (const file of ["managed-mcp.vault", "managed-mcp-key.enc"]) await expect(stat(join(f.root, file))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("custom storage locations also determine MCP credentials and cross-server ownership", async () => {
    const f = await managedMcpFixture();
    await stopMcpManager(f.config);
    const prior = process.env.LEGALWORK_STORAGE_STORE;
    process.env.LEGALWORK_STORAGE_STORE = join(f.root, "custom-storage", "file-storage.json");
    const first = new McpManagerStore(f.config);
    const second = new McpManagerStore({ ...f.config, configPath: join(f.root, "other-server", "server.json") });
    try {
      await first.open();
      expect(first.path).toBe(join(f.root, "custom-storage", "storage-oauth.vault"));
      expect(second.path).toBe(first.path);
      await expect(second.open()).rejects.toMatchObject({ code: "mcp_manager_in_use" });
    } finally {
      first.close(); second.close();
      if (prior === undefined) delete process.env.LEGALWORK_STORAGE_STORE;
      else process.env.LEGALWORK_STORAGE_STORE = prior;
    }
  });

  test("one shared connection, encrypted provider configuration, runtime-only gateway credentials", async () => {
    const f = await managedMcpFixture({ CLIENT_ID: "client", CLIENT_SECRET: "provider-client-secret" });
    await addMcp(f.config, "ws_a", name, { ...f.settings, oauth: { clientId: "client", clientSecret: "provider-client-secret" } });
    const { code, state } = await f.signIn();
    const a = await f.gatewayEntry("ws_a"), b = await f.gatewayEntry("ws_b");
    expect(a.url.split("/").at(-1)).toBe(b.url.split("/").at(-1));
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
    expect(a.oauth).toBe(false);
    expect(JSON.stringify(await readGlobalMcpMap(f.config))).not.toContain("provider-client-secret");
    const record = f.manager.store.all()[0];
    expect(record?.tokens?.access_token).toBeDefined();
    const disk = await readFile(f.manager.store.path, "utf8");
    expect(disk).not.toContain("provider-client-secret");
    expect(disk).not.toContain(record?.tokens?.access_token ?? "missing");
    expect(JSON.stringify(a)).not.toContain(record?.tokens?.access_token ?? "missing");
    await expect(f.manager.finishAuthorization("ws_a", name, code, state)).rejects.toThrow("expired or changed");
    const client = await f.connect("ws_b");
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["mock_echo"]);
    expect((await client.callTool({ name: "mock_echo", arguments: { text: "from workspace B" } })).content).toEqual([{ type: "text", text: "from workspace B" }]);
    expect((await client.listResources()).resources[0]?.uri).toBe("mock://resource");
    expect((await client.readResource({ uri: "mock://resource" })).contents[0]).toMatchObject({ text: "MOCK_RESOURCE_CONTENT" });
    expect((await client.listPrompts()).prompts[0]?.name).toBe("mock_prompt");
    expect(JSON.stringify(await client.getPrompt({ name: "mock_prompt" }))).toContain("MOCK_PROMPT_CONTENT");
    expect((await listMcp(f.config, "ws_b", f.workspaces[1]!.path))[0]?.config.url).toBe(f.settings.url);
  });

  test("concurrent workspace requests rotate a refresh token exactly once", async () => {
    const f = await managedMcpFixture();
    await f.signIn();
    const a = await f.connect("ws_a"), b = await f.connect("ws_b");
    await f.expire();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).callTool({ name: "mock_echo", arguments: { text: String(index) } })));
    expect(responses).toHaveLength(12);
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 1, rejectedRefreshGrants: 0, revokedFamilies: 0 });
    await f.expire();
    await Promise.all([a.listResources(), b.listResources()]);
    expect((await f.stats()).refreshGrants).toBe(2);
  });

  test("a successful refresh that omits a replacement preserves the refresh token", async () => {
    const f = await managedMcpFixture({ OMIT_REFRESH_TOKEN_ON_REFRESH: "1", ROTATE_REFRESH_TOKENS: "0" });
    await f.signIn();
    const before = f.manager.store.all()[0]?.tokens?.refresh_token;
    const client = await f.connect();
    await f.expire(); await client.listTools();
    expect(f.manager.store.all()[0]?.tokens?.refresh_token).toBe(before);
    await f.expire(); await client.listTools();
    expect((await f.stats()).refreshGrants).toBe(2);
  });

  test("legacy SSE providers use the same gateway and shared refresh coordinator", async () => {
    const f = await managedMcpFixture({ LEGACY_SSE: "1" }); await f.signIn();
    const client = await f.connect();
    expect((await client.callTool({ name: "mock_echo", arguments: { text: "legacy SSE" } })).content).toEqual([{ type: "text", text: "legacy SSE" }]);
    await f.expire(); await client.listResources();
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 1, rejectedRefreshGrants: 0 });
  });

  test("short-lived tokens are usable and expiry coordinates one proactive refresh", async () => {
    const f = await managedMcpFixture({ ACCESS_TOKEN_TTL_SECONDS: "1" }); await f.signIn();
    const a = await f.connect(), b = await f.connect("ws_b");
    await Promise.all([a.listTools(), b.listTools()]);
    expect((await f.stats()).refreshGrants).toBe(0);
    await Bun.sleep(1100);
    await Promise.all([a.listTools(), b.listTools(), a.listResources(), b.listResources()]);
    expect(await f.stats()).toMatchObject({ refreshGrants: 1, rejectedRefreshGrants: 0 });
  });

  test("workspace overrides use independent accounts and runtime bindings survive directory selection", async () => {
    const f = await managedMcpFixture(); await f.signIn();
    await addMcp(f.config, "ws_b", name, f.settings, "workspace");
    const a = await f.gatewayEntry(), b = await f.gatewayEntry("ws_b");
    expect(a.url.split("/").at(-1)).not.toBe(b.url.split("/").at(-1));
    await f.signIn("ws_b");
    expect((await f.stats()).authorizationGrants).toBe(2);
    const own = await f.manager.engineConfiguration(f.workspaces[1]!.path);
    expect(own.mcp.mock).toMatchObject({ url: b.url, oauth: false });
    expect((await f.manager.engineConfiguration(tmpdir())).mcp).toEqual({});
    expect((await (await f.connect()).listTools()).tools).toHaveLength(1);
    expect((await (await f.connect("ws_b")).listTools()).tools).toHaveLength(1);
  });

  test("concurrent configuration changes cannot leave a stale vault reference", async () => {
    const f = await managedMcpFixture();
    await Promise.all([
      addMcp(f.config, "ws_a", name, { ...f.settings, url: "https://first.example.com/mcp" }),
      addMcp(f.config, "ws_a", name, f.settings),
    ]);
    await f.signIn();
    const tokens = f.manager.store.all()[0]?.tokens;
    await addMcp(f.config, "ws_a", name, { ...f.settings, timeout: 25_000 });
    expect(f.manager.store.all()[0]?.tokens).toEqual(tokens);
    expect((await f.stats()).authorizationGrants).toBe(1);
    await Promise.all([removeMcp(f.config, "ws_a", name), addMcp(f.config, "ws_a", name, f.settings)]);
    expect((await readGlobalMcpMap(f.config)).mock?.managedConnectionId).toBe(f.manager.store.all()[0]?.id);
    expect((await f.gatewayEntry()).url).toContain(f.manager.store.all()[0]!.id);
  });

  test.each(["enabled", "timeout", "provider"])("a failed %s configuration write leaves the saved connection usable and retryable", async change => {
    const f = await managedMcpFixture();
    await f.signIn();
    const client = await f.connect();
    const previous = (await f.manager.find("ws_a", name))?.record;
    if (!previous) throw new Error("Missing saved connection");
    const descriptor = (await readGlobalMcpMap(f.config))[name];
    const input = change === "enabled" ? { ...descriptor, enabled: false }
      : change === "timeout" ? { ...f.settings, timeout: 25_000 }
      : { ...f.settings, url: "https://replacement.example/mcp" };
    const write = spyOn(f.manager.store, "put").mockRejectedValueOnce(new Error("temporary vault write failure"));
    try {
      await expect(f.manager.configure(GLOBAL_MCP_ID, name, input)).rejects.toThrow("temporary vault write failure");
    } finally { write.mockRestore(); }

    expect(f.manager.store.get(previous.key)).toEqual(previous);
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "connected" });
    expect((await client.listTools()).tools).toHaveLength(1);
    expect((await (await f.manager.client(previous)).listTools()).tools).toHaveLength(1);
    expect((await f.stats()).authorizationGrants).toBe(1);

    const replacement = await f.manager.configure(GLOBAL_MCP_ID, name, input);
    expect(replacement.revision).not.toBe(previous.revision);
    expect(f.manager.store.get(previous.key)).toEqual(replacement);
    await expect(f.manager.client(previous)).rejects.toThrow("no longer available");
    if (change === "provider") {
      expect(replacement.id).not.toBe(previous.id);
      expect(replacement.tokens).toBeUndefined();
    } else {
      expect(replacement.id).toBe(previous.id);
      expect(replacement.tokens).toEqual(previous.tokens);
    }
  });

  test("disconnect during refresh cancels it and a late response cannot restore credentials", async () => {
    const f = await managedMcpFixture({ REFRESH_DELAY_MS: "600" });
    await f.signIn();
    const client = await f.connect();
    await f.expire();
    const pending = client.listTools().then(() => "completed", () => "cancelled");
    await until(async () => (await f.stats()).refreshGrants === 1, "refresh began");
    await f.manager.logout("ws_b", name);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect(await pending).toBe("cancelled");
    await Bun.sleep(650);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "needs_auth" });
    expect(await f.manager.status("ws_b", name)).toMatchObject({ status: "needs_auth" });
    await f.signIn();
    expect((await (await f.connect()).listTools()).tools).toHaveLength(1);
  });

  test("gateway authorization binds workspace and connection and does not grant app access", async () => {
    const f = await managedMcpFixture();
    const a = await f.gatewayEntry(), b = await f.gatewayEntry("ws_b");
    expect((await fetch(a.url)).status).toBe(401);
    expect((await fetch(a.url, { headers: { Authorization: `Bearer ${f.config.token}` } })).status).toBe(401);
    expect((await fetch(b.url, { headers: a.headers })).status).toBe(401);
    expect(f.manager.authorize(new Request(a.url, { headers: a.headers }), "ws_b", a.url.split("/").at(-1) ?? "")).toBe(false);
  });

  test("disable and remove reject existing gateway credentials immediately", async () => {
    const f = await managedMcpFixture();
    await f.signIn();
    const entry = await f.gatewayEntry();
    await setMcpEnabled(f.config, "ws_a", name, false);
    expect((await fetch(entry.url, { headers: entry.headers })).status).toBe(503);
    await setMcpEnabled(f.config, "ws_a", name, true);
    expect((await (await f.connect()).listTools()).tools).toHaveLength(1);
    await removeMcp(f.config, "ws_a", name);
    expect(f.manager.store.all()).toHaveLength(0);
    expect((await fetch(entry.url, { headers: entry.headers })).status).toBe(503);
  });

  test("restart preserves provider credentials and rotates the gateway bearer", async () => {
    const f = await managedMcpFixture();
    await f.signIn();
    const before = await f.gatewayEntry();
    const access = f.manager.store.all()[0]?.tokens?.access_token;
    await stopMcpManager(f.config);
    const next = initializeMcpManager(f.config);
    await next.reconcile();
    const entries = await next.engineEntries("ws_a", await runtimeMcpMapForWorkspace(f.config, "ws_a"));
    const after = entrySchema.parse(entries[name]);
    expect(after.headers.Authorization).not.toBe(before.headers.Authorization);
    expect(next.authorize(new Request(before.url, { headers: before.headers }), "ws_a", after.url.split("/").at(-1) ?? "")).toBe(false);
    expect(next.store.all()[0]?.tokens?.access_token).toBe(access);
    expect((await next.client(next.store.all()[0]!)).getServerCapabilities()?.tools).toBeDefined();
    expect((await f.stats()).authorizationGrants).toBe(1);
  });

  test("a second manager cannot consume the same credential store", async () => {
    const f = await managedMcpFixture();
    const second = new McpConnectorManager(f.config);
    cleanups.push(() => second.close());
    await expect(second.reconcile()).rejects.toThrow("Another LegalWork server owns");
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "mcp-manager.ts")).href;
    const script = `import { McpConnectorManager } from ${JSON.stringify(moduleUrl)};
      const manager = new McpConnectorManager({ configPath: ${JSON.stringify(f.config.configPath)}, workspaces: [] });
      try { await manager.configure("child", "child", { type: "remote", url: "https://example.com/mcp" }); process.exitCode = 1; }
      catch (error) { if (error.code !== "mcp_manager_in_use") throw error; process.stdout.write(error.code); }
      finally { await manager.close(); }`;
    const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 5000 });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("mcp_manager_in_use");
  });

  test("migration moves remote config secrets to the vault, preserving local MCPs", async () => {
    const f = await managedMcpFixture();
    const local = { type: "local", command: ["example-mcp"] };
    await writeRuntimeOpencodeConfig(f.config, GLOBAL_MCP_ID, () => ({ mcp: { imported: { type: "remote", url: f.settings.url, headers: { Authorization: "Bearer old-static-secret" }, oauth: false }, local } }));
    await f.manager.reconcile();
    const stored = await readGlobalMcpMap(f.config);
    expect(JSON.stringify(stored)).not.toContain("old-static-secret");
    const entries = await f.manager.engineEntries("ws_a", stored);
    expect(entries.local).toEqual(local);
    expect(JSON.stringify(entries)).not.toContain("old-static-secret");
    expect((await listMcp(f.config, "ws_a", f.workspaces[0]!.path)).find(item => item.name === "imported")?.config.headers).toEqual({ Authorization: "Bearer old-static-secret" });
  });

  test("restart migration preserves managed workspace overrides and ignores stale derived gateway entries", async () => {
    const f = await managedMcpFixture();
    await addMcp(f.config, "ws_b", name, f.settings, "workspace");
    const scoped = (await f.gatewayEntry("ws_b")).url;
    const stale = await f.entries("ws_a");
    await removeMcp(f.config, "ws_a", name);
    const runtimeConfigFile = join(f.root, "runtime-config.json");
    await writeFile(runtimeConfigFile, JSON.stringify({ mcp: stale }));
    const imported = await importConnectorsIntoSharedRow(f.config, { runtimeConfigFile, globalOpencodeConfigFile: join(f.root, "old-config.json") });
    expect(imported.imported).toEqual([]);
    expect(await readGlobalMcpMap(f.config)).toEqual({});
    expect((await readRuntimeOpencodeConfig(f.config, "ws_b")).mcp?.mock?.managedConnectionId).toBeDefined();
    expect((await f.gatewayEntry("ws_b")).url).toBe(scoped);
  });

  test("restart after shared reconciliation preserves an unmigrated workspace override", async () => {
    const f = await managedMcpFixture();
    const shared = await readGlobalMcpMap(f.config);
    const own: RemoteMcp = { ...f.settings, type: "remote", url: "https://workspace.example/mcp", headers: { "X-Workspace-Key": "synthetic-key" }, oauth: { clientId: "workspace-client" } };
    // Startup saved the shared descriptor, but stopped before converting this row.
    await writeRuntimeOpencodeConfig(f.config, "ws_b", () => ({ mcp: { [name]: own }, plugin: ["keep-me"] }));
    await stopMcpManager(f.config);
    const sources = { runtimeConfigFile: join(f.root, "runtime.json"), globalOpencodeConfigFile: join(f.root, "old-config.json") };
    expect((await importConnectorsIntoSharedRow(f.config, sources)).imported).toEqual([]);
    expect(await readGlobalMcpMap(f.config)).toEqual(shared);
    expect(await readRuntimeOpencodeConfig(f.config, "ws_b")).toEqual({ mcp: { [name]: own }, plugin: ["keep-me"] });

    const manager = initializeMcpManager(f.config);
    await manager.reconcile();
    const global = await manager.find("ws_a", name);
    const workspace = await manager.find("ws_b", name);
    expect(global?.record.config.url).toBe(f.settings.url);
    expect(workspace?.record.config).toEqual(own);
    expect(workspace?.record.id).not.toBe(global?.record.id);
    const managed = await readRuntimeOpencodeConfig(f.config, "ws_b");
    expect(managed.mcp?.[name]?.managedConnectionId).toBe(workspace?.record.id);
    expect(JSON.stringify(managed)).not.toContain("synthetic-key");
    await importConnectorsIntoSharedRow(f.config, sources);
    await manager.reconcile();
    expect(await readRuntimeOpencodeConfig(f.config, "ws_b")).toEqual(managed);
    expect((await manager.find("ws_b", name))?.record).toEqual(workspace?.record);
  });

  test("opaque provider URLs are encrypted rather than copied into public metadata", async () => {
    const f = await managedMcpFixture();
    await addMcp(f.config, "ws_a", "private-url", { type: "remote", url: "https://provider.example.com/private-path-token/mcp?api_key=secret-query", oauth: false });
    const metadata = JSON.stringify(await readGlobalMcpMap(f.config));
    expect(metadata).not.toContain("private-path-token");
    expect(metadata).not.toContain("secret-query");
    const config = await f.manager.engineConfiguration(f.workspaces[0]!.path);
    expect(JSON.stringify(config)).not.toContain("secret-query");
  });

  test("OAuth state must match and callback expires on a superseding login", async () => {
    const f = await managedMcpFixture();
    const first = await f.manager.startAuthorization("ws_a", name);
    const approval = await fetch(first.authorizationUrl, { redirect: "manual" });
    const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;
    await expect(f.manager.finishAuthorization("ws_a", name, code, "wrong-state")).rejects.toThrow("expired or changed");
    await f.manager.startAuthorization("ws_a", name);
    await expect(f.manager.finishAuthorization("ws_a", name, code, first.oauthState)).rejects.toThrow("expired or changed");
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
  });

  test("progress and cancellation reach the provider without cancelling another workspace", async () => {
    const f = await managedMcpFixture(); await f.signIn();
    const a = await f.connect(), b = await f.connect("ws_b");
    const progress: number[] = [];
    await a.callTool({ name: "mock_echo", arguments: { text: "REPORT_PROGRESS" } }, undefined, { onprogress: value => { progress.push(value.progress); } });
    expect(progress).toEqual([1]);
    const controller = new AbortController();
    const pending = a.callTool({ name: "mock_echo", arguments: { text: "WAIT_FOR_CANCEL" } }, undefined, { signal: controller.signal }).catch(() => "cancelled");
    await until(async () => (await f.stats()).toolCalls === 2, "long tool call");
    controller.abort();
    expect(await pending).toBe("cancelled");
    await until(async () => (await f.stats()).cancelledCalls === 1, "provider cancellation");
    expect((await b.callTool({ name: "mock_echo", arguments: { text: "other workspace" } })).content).toEqual([{ type: "text", text: "other workspace" }]);
  });

  test("provider errors and ambiguous network failures never replay a tool operation", async () => {
    const f = await managedMcpFixture(); await f.signIn();
    const client = await f.connect();
    const result = await client.callTool({ name: "mock_echo", arguments: { text: "PROVIDER_ERROR" } });
    expect(result.isError).toBe(true);
    expect((await f.stats()).toolCalls).toBe(1);
    await expect(client.callTool({ name: "mock_echo", arguments: { text: "DROP_AFTER_EXECUTION" } })).rejects.toThrow();
    expect((await f.stats()).toolCalls).toBe(2);
    await Bun.sleep(3100);
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(await f.stats()).toMatchObject({ toolCalls: 2, authorizationGrants: 1 });
  });

  test("transient token errors preserve credentials and back off concurrent refresh attempts", async () => {
    const f = await managedMcpFixture(); await f.signIn(); const client = await f.connect();
    const saved = f.manager.store.all()[0]?.tokens;
    await fetch(`${f.providerUrl}/refresh-mode`, { method: "POST", body: JSON.stringify({ mode: "unavailable" }) });
    await f.expire();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => client.listTools()));
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect((await f.stats()).refreshAttempts).toBe(1);
    expect(f.manager.store.all()[0]?.tokens).toEqual(saved);
  });

  test("a rejected refresh requires one shared reconnect instead of repeated automatic logins", async () => {
    const f = await managedMcpFixture(); await f.signIn(); const a = await f.connect(), b = await f.connect("ws_b");
    await fetch(`${f.providerUrl}/refresh-mode`, { method: "POST", body: JSON.stringify({ mode: "invalid_grant" }) });
    await f.expire();
    await Promise.allSettled([a.listTools(), b.listTools()]);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    for (const workspace of ["ws_a", "ws_b"]) expect(await f.manager.status(workspace, name)).toMatchObject({ status: "needs_auth" });
    expect(await f.stats()).toMatchObject({ refreshAttempts: 1, authorizationGrants: 1 });
  });

  test("an OAuth callback with a mismatched issuer cannot exchange the code", async () => {
    const f = await managedMcpFixture();
    const start = await f.manager.startAuthorization("ws_a", name);
    const response = await fetch(start.authorizationUrl, { redirect: "manual" });
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    await expect(f.manager.finishAuthorization("ws_a", name, code, start.oauthState, "https://wrong-issuer.example")).rejects.toThrow();
    expect((await f.stats()).authorizationGrants).toBe(0);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
  });

  test("RFC 9207 issuer-bearing callbacks finish sign-in and preserve issuer-bound credentials", async () => {
    const f = await managedMcpFixture({ OAUTH_ISSUER_PARAMETER: "1" });
    await f.signIn();
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
    expect(f.manager.store.all()[0]?.issuer).toBe(f.providerUrl);
  });

  test("browser preflights allow issuer-bearing OAuth callbacks through the server", async () => {
    const f = await managedMcpFixture({ OAUTH_ISSUER_PARAMETER: "1" });
    f.listener.stop(true); f.config.port = 0;
    const origin = "http://localhost:5394";
    f.config.corsOrigins = [origin];
    const server = await startServer(f.config);
    cleanups.push(() => server.stop());
    const endpoint = `http://127.0.0.1:${server.port}/workspace/ws_a/opencode/mcp/${name}/auth/callback`;
    const requested = ["authorization", "content-type", "x-legalwork-oauth-state", "x-legalwork-oauth-issuer"];
    const preflight = await fetch(endpoint, { method: "OPTIONS", headers: {
      origin, "access-control-request-method": "POST", "access-control-request-headers": requested.join(","),
    } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    const allowed = preflight.headers.get("access-control-allow-headers")?.toLowerCase().split(/,\s*/) ?? [];
    for (const header of requested) expect(allowed).toContain(header);
    const denied = await fetch(endpoint, { method: "OPTIONS", headers: { origin: "https://untrusted.example", "access-control-request-method": "POST" } });
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);

    const start = await f.manager.startAuthorization("ws_a", name);
    const approval = await fetch(start.authorizationUrl, { redirect: "manual" });
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.searchParams.get("iss")).toBe(f.providerUrl);
    const response = await fetch(endpoint, { method: "POST", headers: {
      origin, authorization: `Bearer ${f.config.token}`, "content-type": "application/json",
      "x-legalwork-oauth-state": start.oauthState, "x-legalwork-oauth-issuer": f.providerUrl,
    }, body: JSON.stringify({ code: callback.searchParams.get("code") }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await response.json()).toMatchObject({ status: "connected" });
    expect(f.manager.store.all()[0]?.issuer).toBe(f.providerUrl);
    expect((await f.stats()).authorizationGrants).toBe(1);
  });

  test("insufficient scope requests consent for the scope union without discarding the saved grant", async () => {
    const f = await managedMcpFixture();
    await f.signIn();
    const client = await f.connect();
    const before = f.manager.store.all()[0]?.tokens?.refresh_token;
    await fetch(`${f.providerUrl}/required-scope`, { method: "POST", body: JSON.stringify({ scope: "mcp:extra" }) });
    await expect(client.callTool({ name: "mock_echo", arguments: { text: "requires consent" } })).rejects.toThrow();
    const record = f.manager.store.all()[0]!;
    expect(record.tokens?.refresh_token).toBe(before);
    expect(record.requiredScope).toContain("mcp:extra");
    expect((await f.stats()).refreshAttempts).toBe(0);
    const start = await f.manager.startAuthorization("ws_a", name);
    expect(new URL(start.authorizationUrl).searchParams.get("scope")).toContain("mcp:extra");
    await fetch(`${f.providerUrl}/required-scope`, { method: "POST", body: JSON.stringify({ scope: "" }) });
    const response = await fetch(start.authorizationUrl, { redirect: "manual" });
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    await f.manager.finishAuthorization("ws_a", name, code, start.oauthState);
    expect(f.manager.store.all()[0]?.requiredScope).toBeUndefined();
  });

  test("a late scope rejection cannot invalidate a newer successful sign-in", async () => {
    const f = await managedMcpFixture();
    await f.signIn();
    const client = await f.connect();
    const old = f.manager.store.all()[0]!.tokens!.access_token;
    let ready = () => {};
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    let release = (_response: Response) => {};
    const response = new Promise<Response>(resolve => { release = resolve; });
    const original = globalThis.fetch;
    const intercepted = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input) === `${f.providerUrl}/mcp` && typeof init?.body === "string" && init.body.includes("LATE_SCOPE_TEST")) { ready(); return response; }
      return original(input, init);
    }, { preconnect: original.preconnect }));
    try {
      const pending = client.callTool({ name: "mock_echo", arguments: { text: "LATE_SCOPE_TEST" } }).catch(() => null);
      await waiting;
      const login = f.signIn();
      await until(async () => f.manager.store.all()[0]?.tokens?.access_token !== old, "new sign-in credential commit");
      release(new Response("denied", { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="stale:scope"' } }));
      await Promise.all([pending, login]);
      expect(f.manager.store.all()[0]?.reconnectRequired).toBe(false);
      expect(f.manager.store.all()[0]?.requiredScope).toBeUndefined();
      expect(f.manager.store.all()[0]?.tokens?.access_token).not.toBe(old);
    } finally {
      release(new Response("cancelled", { status: 503 }));
      intercepted.mockRestore();
    }
  });

  test("an insufficient-scope response to the refreshed token still requires consent", async () => {
    const f = await managedMcpFixture();
    await f.signIn();
    const client = await f.connect();
    await f.expire();
    await fetch(`${f.providerUrl}/required-scope`, { method: "POST", body: JSON.stringify({ scope: "mcp:extra" }) });
    await expect(client.callTool({ name: "mock_echo", arguments: { text: "refresh then consent" } })).rejects.toThrow();
    expect(f.manager.store.all()[0]?.reconnectRequired).toBe(true);
    expect(f.manager.store.all()[0]?.requiredScope).toContain("mcp:extra");
    expect(await f.stats()).toMatchObject({ refreshGrants: 1, toolCalls: 0 });
  });

  test("an unsuccessful new sign-in preserves an existing usable grant", async () => {
    const f = await managedMcpFixture(); await f.signIn();
    const saved = f.manager.store.all()[0]?.tokens;
    const flow = await f.manager.startAuthorization("ws_a", name);
    await expect(f.manager.finishAuthorization("ws_a", name, "invalid-code", flow.oauthState)).rejects.toThrow();
    expect(f.manager.store.all()[0]?.tokens).toEqual(saved);
  });

  test("an unreadable shared vault preserves data and never gives engines provider credentials", async () => {
    const f = await managedMcpFixture(); await f.signIn();
    const contents = await readFile(f.manager.store.path);
    await stopMcpManager(f.config);
    const priorKey = process.env.LEGALWORK_ENCRYPTION_KEY;
    process.env.LEGALWORK_ENCRYPTION_KEY = "wrong-app-encryption-key";
    const manager = initializeMcpManager(f.config);
    try {
      await expect(manager.reconcile()).rejects.toMatchObject({ code: "mcp_secure_storage_unreadable" });
      const entries = await manager.engineEntries("ws_a", await runtimeMcpMapForWorkspace(f.config, "ws_a"));
      expect(entries.mock).toMatchObject({ enabled: false, oauth: false });
      expect(await readFile(manager.store.path)).toEqual(contents);
    } finally {
      if (priorKey === undefined) delete process.env.LEGALWORK_ENCRYPTION_KEY;
      else process.env.LEGALWORK_ENCRYPTION_KEY = priorKey;
    }
    await manager.reconcile();
    expect(manager.store.all()[0]?.tokens).toBeDefined();
  });
});

async function legacyFixture() {
  const f = await managedMcpFixture();
  await f.signIn();
  const record = f.manager.store.all()[0]!;
  if (!record.tokens || !record.client) throw new Error("Missing fixture grant");
  const entry = { serverUrl: record.config.url, codeVerifier: "old-pending-verifier", oauthState: "old-state",
    tokens: { accessToken: record.tokens.access_token, refreshToken: record.tokens.refresh_token,
      expiresAt: record.expiresAt === undefined ? undefined : record.expiresAt / 1000, scope: record.tokens.scope },
    clientInfo: { clientId: record.client.client_id, clientSecret: record.client.client_secret,
      clientIdIssuedAt: record.client.client_id_issued_at, clientSecretExpiresAt: record.client.client_secret_expires_at },
  };
  const authPath = join(f.root, "mcp-auth.json");
  const source = { mock: entry, unrelated: { custom: "keep exactly", tokens: { accessToken: "other-account" } } };
  await writeFile(authPath, JSON.stringify(source), { mode: 0o600 });
  await f.manager.store.put({ ...record, tokens: undefined, client: undefined, expiresAt: undefined, issuer: undefined });
  const options = { authPath, quiescent: async () => true };
  return { ...f, entry, authPath, source, options };
}

describe("legacy MCP credential handover", () => {
  test("default OAuth configuration transfers an expired access token with a usable refresh token", async () => {
    const f = await legacyFixture();
    await addMcp(f.config, "ws_a", name, { ...f.settings, oauth: undefined });
    f.source.mock.tokens.expiresAt = 1;
    await writeFile(f.authPath, JSON.stringify(f.source));
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    await f.expire();
    expect(await engineAccessToken(f.config, "ws_b", name)).toBeDefined();
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 1, rejectedRefreshGrants: 0 });
    await setMcpEnabled(f.config, "ws_a", name, false);
    await expect(engineAccessToken(f.config, "ws_b", name)).rejects.toThrow("no longer available");
  });

  test("a working grant survives upgrade, shared refresh, appliance access and restart without another sign-in", async () => {
    const f = await legacyFixture();
    expect(await migrateLegacyMcpOAuth(f.config, f.options)).toEqual({ migrated: [name], deferred: false });
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual({ unrelated: f.source.unrelated });
    const record = f.manager.store.all()[0]!;
    expect(record.tokens?.access_token).toBe(f.entry.tokens.accessToken);
    expect(record.client?.client_id).toBe(f.entry.clientInfo.clientId);
    expect(record.expiresAt).toBe(f.entry.tokens.expiresAt! * 1000);
    expect(record.legacyMigration).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("old-pending-verifier");
    const a = await f.connect(), b = await f.connect("ws_b");
    await f.expire();
    await Promise.all([a.listTools(), b.listResources()]);
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 1, rejectedRefreshGrants: 0, revokedFamilies: 0 });
    const rotated = f.manager.store.all()[0]?.tokens;
    expect(rotated?.refresh_token).not.toBe(f.entry.tokens.refreshToken);
    expect(await engineAccessToken(f.config, "ws_a", name)).toBe(rotated?.access_token);
    await stopMcpManager(f.config);
    const restarted = initializeMcpManager(f.config); await restarted.reconcile();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([]);
    expect(restarted.store.all()[0]?.tokens).toEqual(rotated);
    expect((await readFile(restarted.store.path)).includes(Buffer.from(f.entry.tokens.accessToken))).toBe(false);
  });

  test("active legacy engines defer transfer without touching the original grant", async () => {
    const f = await legacyFixture();
    const original = await readFile(f.authPath);
    expect(await migrateLegacyMcpOAuth(f.config, { ...f.options, quiescent: async () => false })).toEqual({ migrated: [], deferred: true });
    expect(await readFile(f.authPath)).toEqual(original);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
  });

  test("deferred migration reports waiting and retries without a browser or an app restart", async () => {
    const f = await legacyFixture();
    let available = false;
    const original = await readFile(f.authPath);
    expect((await migrateLegacyMcpOAuth(f.config, { ...f.options, quiescent: async () => available })).deferred).toBe(true);
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "connecting", message: expect.stringContaining("retry automatically") });
    await expect(f.connect()).rejects.toThrow("same connector credentials");
    await expect(f.manager.startAuthorization("ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_pending" });
    expect(await readFile(f.authPath)).toEqual(original);
    const stop = startLegacyMcpMigrationRetry(f.config, () => new Set([123]), { ...f.options, quiescent: async () => available, intervalMs: 5 });
    try {
      available = true;
      await until(async () => Boolean(f.manager.store.all()[0]?.tokens), "automatic credential handover");
    } finally { await stop(); }
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
    expect((await f.stats()).authorizationGrants).toBe(1);
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual({ unrelated: f.source.unrelated });
  });

  test("persistent conflicts pause after six attempts and a manual retry recovers without another sign-in", async () => {
    const f = await legacyFixture();
    const original = await readFile(f.authPath);
    let available = false, checks = 0;
    const quiescent = async () => { checks++; return available; };
    await migrateLegacyMcpOAuth(f.config, { ...f.options, quiescent });
    const stop = startLegacyMcpMigrationRetry(f.config, () => new Set(), { ...f.options, quiescent, intervalMs: 5 });
    try {
      await until(async () => (await f.manager.status("ws_a", name))?.status === "failed", "bounded migration retries");
      expect(await f.manager.status("ws_b", name)).toMatchObject({ status: "failed", migration: { state: "blocked", canReconnect: true }, error: expect.stringContaining("Another OpenCode application") });
      expect(checks).toBe(6);
      await Bun.sleep(40);
      expect(checks).toBe(6);
      expect(await readFile(f.authPath)).toEqual(original);
      await expect(f.manager.startAuthorization("ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_blocked" });
      await setMcpEnabled(f.config, "ws_a", name, false);
      await setMcpEnabled(f.config, "ws_a", name, true);
      expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "failed", migration: { state: "blocked" } });
      f.listener.stop(true); f.config.port = 0;
      const engine = Bun.serve({ port: 0, fetch: () => Response.json({ [name]: { status: "failed", error: "Gateway unavailable" } }) });
      cleanups.push(() => engine.stop(true));
      f.config.opencodeBaseUrl = `http://127.0.0.1:${engine.port}`;
      const server = await startServer(f.config);
      cleanups.push(() => server.stop());
      const endpoint = `http://127.0.0.1:${server.port}/workspace/ws_a/mcp/${name}/migration`;
      const headers = { "x-legalwork-host-token": f.config.hostToken, "content-type": "application/json" };
      const recovering = spyOn(McpRecovery.prototype, "isRecovering").mockReturnValue(true);
      try {
        const polled = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_a/opencode/mcp`, { headers });
        expect(polled.status).toBe(200);
        expect(await polled.json()).toMatchObject({ [name]: { status: "failed", migration: { state: "blocked" } } });
      } finally { recovering.mockRestore(); }
      const gateway = await f.gatewayEntry();
      expect((await fetch(endpoint, { method: "POST", headers: gateway.headers, body: JSON.stringify({ action: "retry" }) })).status).toBe(401);
      available = true;
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "retry" }) })).status).toBe(200);
      await Promise.all([retryLegacyMcpMigration(f.config), retryLegacyMcpMigration(f.config)]);
      expect(f.manager.store.all()[0]?.tokens?.access_token).toBe(f.entry.tokens.accessToken);
      expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
      expect((await f.stats()).authorizationGrants).toBe(1);
    } finally { await stop(); }
  });

  test("a blocked activation can reconnect through the API without erasing its encrypted recovery copy", async () => {
    const f = await legacyFixture();
    const put = f.manager.store.put.bind(f.manager.store);
    const write = spyOn(f.manager.store, "put").mockImplementation(async record => {
      if (!record.legacyHandoffPending) throw new Error("activation failure including secret=must-not-leak");
      await put(record);
    });
    try { for (let i = 0; i < 6; i++) await migrateLegacyMcpOAuth(f.config, f.options); }
    finally { write.mockRestore(); }
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "failed", migration: { state: "blocked" } });
    expect(JSON.stringify(await f.manager.status("ws_a", name))).not.toContain("must-not-leak");
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual({ unrelated: f.source.unrelated });
    const journalKey = `managed-mcp-migration:${createHash("sha256").update(await realpath(f.authPath)).digest("hex")}`;
    const vault = new OAuthVault(oauthVaultPath(f.config));
    const journal = await vault.getEntry(journalKey, z.unknown());
    expect(JSON.stringify(journal)).toContain(f.entry.tokens.accessToken);
    // A moved legacy location must not leave the staged flag spinning forever.
    expect((await migrateLegacyMcpOAuth(f.config, { ...f.options, authPath: join(f.root, "moved", "mcp-auth.json") })).deferred).toBe(true);
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "failed", migration: { state: "blocked" }, error: expect.stringContaining("transfer record") });
    f.listener.stop(true); f.config.port = 0;
    const server = await startServer(f.config);
    cleanups.push(() => server.stop());
    const endpoint = `http://127.0.0.1:${server.port}/workspace/ws_a/mcp/${name}/migration`;
    expect((await fetch(endpoint, { method: "POST", body: JSON.stringify({ action: "reconnect" }) })).status).toBe(401);
    const failure = spyOn(f.manager.store, "put").mockRejectedValueOnce(new Error("credential storage is unavailable"));
    try {
      expect((await fetch(endpoint, { method: "POST", headers: { "x-legalwork-host-token": f.config.hostToken, "content-type": "application/json" }, body: JSON.stringify({ action: "reconnect" }) })).status).toBe(503);
      expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "failed", migration: { state: "blocked" } });
      expect(await vault.getEntry(journalKey, z.unknown())).toEqual(journal);
    } finally { failure.mockRestore(); }
    const reconnect = await fetch(endpoint, { method: "POST", headers: { "x-legalwork-host-token": f.config.hostToken, "content-type": "application/json" }, body: JSON.stringify({ action: "reconnect" }) });
    expect(reconnect.status).toBe(200);
    expect(await vault.getEntry(journalKey, z.unknown())).toEqual(journal);
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "needs_auth" });
    await f.signIn();
    const newTokens = f.manager.store.all()[0]?.tokens;
    expect(newTokens?.access_token).not.toBe(f.entry.tokens.accessToken);
    await migrateLegacyMcpOAuth(f.config, f.options);
    expect(f.manager.store.all()[0]?.tokens).toEqual(newTokens);
    await expect(f.manager.prepareMigrationReconnect("ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_not_pending" });
    expect(f.manager.store.all()[0]?.tokens).toEqual(newTokens);
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
    expect((await f.stats()).authorizationGrants).toBe(2);
  });

  test("permanent vault failure explains the blocker and does not offer to overwrite credentials", async () => {
    const f = await legacyFixture();
    const source = await readFile(f.authPath), destination = await readFile(f.manager.store.path);
    await stopMcpManager(f.config);
    const prior = process.env.LEGALWORK_ENCRYPTION_KEY;
    process.env.LEGALWORK_ENCRYPTION_KEY = "unavailable-existing-key";
    const manager = initializeMcpManager(f.config);
    try {
      for (let i = 0; i < 6; i++) await migrateLegacyMcpOAuth(f.config, f.options);
      expect(await manager.status("ws_a", name)).toMatchObject({ status: "failed", migration: { state: "blocked", canReconnect: false }, error: expect.stringContaining("encryption key") });
      expect(await readFile(f.authPath)).toEqual(source);
      expect(await readFile(manager.store.path)).toEqual(destination);
    } finally {
      if (prior === undefined) delete process.env.LEGALWORK_ENCRYPTION_KEY;
      else process.env.LEGALWORK_ENCRYPTION_KEY = prior;
    }
    await manager.reconcile();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
  });

  test("only the owned gateway engine PID is excluded from ownership checks on Windows and Unix", () => {
    const windows = '"opencode-x64.exe","123","Console","1","2,000 K"';
    const unix = "123 /path/opencode-x64";
    expect(hasOpencodeProcess(windows, "win32", new Set([123]))).toBe(false);
    expect(hasOpencodeProcess(windows + '\n"opencode.exe","456","Console","1","2,000 K"', "win32", new Set([123]))).toBe(true);
    expect(hasOpencodeProcess(unix, "darwin", new Set([123]))).toBe(false);
    expect(hasOpencodeProcess(unix + "\n456 /path/opencode", "darwin", new Set([123]))).toBe(true);
  });

  test("a legacy source changing during the ownership check is retried rather than leaving migration stuck", async () => {
    const f = await legacyFixture();
    let first = true;
    const result = await migrateLegacyMcpOAuth(f.config, { ...f.options, quiescent: async () => {
      if (first) { first = false; await writeFile(f.authPath, JSON.stringify({ ...f.source, mock: { ...f.entry, updatedByLegacyEngine: true } })); }
      return true;
    } });
    expect(result.deferred).toBe(true);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
  });

  test("a failed encrypted backup preserves the source and does not activate credentials", async () => {
    const f = await legacyFixture();
    const original = await readFile(f.authPath);
    const write = spyOn(OAuthVault.prototype, "setEntry").mockRejectedValueOnce(new Error("vault write failed"));
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { write.mockRestore(); }
    expect(await readFile(f.authPath)).toEqual(original);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
  });

  test("an unreadable destination vault leaves the legacy grant available for a later retry", async () => {
    const f = await legacyFixture();
    const source = await readFile(f.authPath), destination = await readFile(f.manager.store.path);
    await stopMcpManager(f.config);
    const prior = process.env.LEGALWORK_ENCRYPTION_KEY;
    process.env.LEGALWORK_ENCRYPTION_KEY = "unavailable-existing-key";
    const restarted = initializeMcpManager(f.config);
    try {
      expect(await migrateLegacyMcpOAuth(f.config, f.options)).toEqual({ migrated: [], deferred: true });
      expect(await readFile(f.authPath)).toEqual(source);
      expect(await readFile(restarted.store.path)).toEqual(destination);
    } finally {
      if (prior === undefined) delete process.env.LEGALWORK_ENCRYPTION_KEY;
      else process.env.LEGALWORK_ENCRYPTION_KEY = prior;
    }
    await restarted.reconcile();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
  });

  test("a failed destination write preserves the original grant and retries after restart", async () => {
    const f = await legacyFixture();
    const write = spyOn(f.manager.store, "put").mockRejectedValueOnce(new Error("simulated process exit"));
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { write.mockRestore(); }
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual(f.source);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    await stopMcpManager(f.config);
    const restarted = initializeMcpManager(f.config); await restarted.reconcile();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    expect(restarted.store.all()[0]?.tokens?.access_token).toBe(f.entry.tokens.accessToken);
    expect((await restarted.client(restarted.store.all()[0]!)).getServerCapabilities()?.tools).toBeDefined();
    expect((await f.stats()).authorizationGrants).toBe(1);
  });

  test.each(["staging", "activation"])("an interrupted %s keeps credentials gated and resumes after restart", async phase => {
    const f = await legacyFixture();
    const put = f.manager.store.put.bind(f.manager.store);
    const write = spyOn(f.manager.store, "put").mockImplementation(async record => {
      if (phase === "staging") { await put(record); throw new Error("exit after staging"); }
      if (!record.legacyHandoffPending) throw new Error("activation write failed");
      await put(record);
    });
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { write.mockRestore(); }
    expect(f.manager.store.all()[0]?.legacyHandoffPending).toBe(true);
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual(phase === "staging" ? f.source : { unrelated: f.source.unrelated });
    await expect(engineAccessToken(f.config, "ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_pending" });
    await expect(f.manager.startAuthorization("ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_pending" });
    await stopMcpManager(f.config);
    const restarted = initializeMcpManager(f.config); await restarted.reconcile();
    expect(await restarted.status("ws_a", name)).toMatchObject({ status: "connecting" });
    await expect(engineAccessToken(f.config, "ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_pending" });
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    expect(restarted.store.all()[0]?.legacyHandoffPending).toBeUndefined();
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual({ unrelated: f.source.unrelated });
    expect((await restarted.client(restarted.store.all()[0]!)).getServerCapabilities()?.tools).toBeDefined();
    expect((await f.stats()).authorizationGrants).toBe(1);
  });

  test("disable and re-enable while staged resumes the same grant without getting stuck", async () => {
    const f = await legacyFixture();
    const adopt = f.manager.adoptLegacyGrant.bind(f.manager);
    const failed = spyOn(f.manager, "adoptLegacyGrant").mockImplementationOnce((id, revision, credentials) =>
      adopt(id, revision, credentials, async () => { throw new Error("Temporary source write failure"); }));
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { failed.mockRestore(); }
    await setMcpEnabled(f.config, "ws_a", name, false);
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "disabled" });
    await setMcpEnabled(f.config, "ws_a", name, true);
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
    expect((await f.stats()).authorizationGrants).toBe(1);
  });

  test("a source retirement failure leaves the old grant intact and the staged replacement unusable", async () => {
    const f = await legacyFixture();
    const adopt = f.manager.adoptLegacyGrant.bind(f.manager);
    const failed = spyOn(f.manager, "adoptLegacyGrant").mockImplementationOnce((id, revision, credentials) =>
      adopt(id, revision, credentials, async () => { throw new Error("Source file is read-only"); }));
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { failed.mockRestore(); }
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual(f.source);
    expect(f.manager.store.all()[0]?.legacyHandoffPending).toBe(true);
    await expect(engineAccessToken(f.config, "ws_a", name)).rejects.toMatchObject({ code: "mcp_migration_pending" });
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
  });

  test("logout before handover wins and preserves the old source", async () => {
    const f = await legacyFixture();
    const adopt = f.manager.adoptLegacyGrant.bind(f.manager);
    const delayed = spyOn(f.manager, "adoptLegacyGrant").mockImplementationOnce(async (...args) => {
      await f.manager.logout("ws_a", name);
      return adopt(...args);
    });
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([]); }
    finally { delayed.mockRestore(); }
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect(await f.manager.status("ws_a", name)).toMatchObject({ status: "needs_auth" });
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([]);
  });

  test.each(["rotated", "logged out"])("an interrupted completion never overwrites credentials that were %s", async mode => {
    const f = await legacyFixture();
    const put = f.manager.store.put.bind(f.manager.store);
    const write = spyOn(f.manager.store, "put").mockImplementation(async record => { await put(record); if (record.legacyMigration && !record.legacyHandoffPending) throw new Error("exit after credential commit"); });
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { write.mockRestore(); }
    if (mode === "rotated") { const client = await f.connect(); await f.expire(); await client.listTools(); }
    else await f.manager.logout("ws_a", name);
    const saved = f.manager.store.all()[0]?.tokens;
    await stopMcpManager(f.config);
    const restarted = initializeMcpManager(f.config); await restarted.reconcile();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([]);
    expect(restarted.store.all()[0]?.tokens).toEqual(saved);
    if (mode === "logged out") expect(await restarted.status("ws_a", name)).toMatchObject({ status: "needs_auth" });
    else expect(saved?.refresh_token).not.toBe(f.entry.tokens.refreshToken);
  });

  test("another profile cannot adopt a claimed grant even if the old file is restored", async () => {
    const f = await legacyFixture();
    const write = spyOn(f.manager.store, "put").mockRejectedValueOnce(new Error("exit after retirement"));
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { write.mockRestore(); }
    await writeFile(f.authPath, JSON.stringify(f.source));
    const other = await managedMcpFixture();
    await addMcp(other.config, "ws_a", name, f.settings);
    expect((await migrateLegacyMcpOAuth(other.config, f.options)).migrated).toEqual([]);
    expect(other.manager.store.all()[0]?.tokens).toBeUndefined();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
  });

  test("a partially completed multi-connector handover preserves rotated tokens while resuming the rest", async () => {
    const f = await legacyFixture();
    await addMcp(f.config, "ws_a", "second", f.settings); await f.signIn("ws_a", "second");
    const second = f.manager.store.all().find(record => record.key.includes("second"))!;
    const secondEntry = { ...f.entry, tokens: { accessToken: second.tokens!.access_token, refreshToken: second.tokens!.refresh_token,
      expiresAt: second.expiresAt! / 1000, scope: second.tokens!.scope }, clientInfo: { clientId: second.client!.client_id } };
    await writeFile(f.authPath, JSON.stringify({ ...f.source, second: secondEntry }));
    await f.manager.store.put({ ...second, tokens: undefined, client: undefined, expiresAt: undefined, issuer: undefined });
    const put = f.manager.store.put.bind(f.manager.store);
    const write = spyOn(f.manager.store, "put").mockImplementation(async record => { await put(record); if (record.legacyMigration && !record.legacyHandoffPending) throw new Error("exit after first connector"); });
    try { expect((await migrateLegacyMcpOAuth(f.config, f.options)).deferred).toBe(true); }
    finally { write.mockRestore(); }
    const client = await f.connect(); await f.expire(); await client.listTools();
    const rotated = f.manager.store.all().find(record => record.key.endsWith('"mock"]'))?.tokens;
    await stopMcpManager(f.config);
    const restarted = initializeMcpManager(f.config); await restarted.reconcile();
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual(["second"]);
    expect(restarted.store.all().find(record => record.key.endsWith('"mock"]'))?.tokens).toEqual(rotated);
    const resumed = restarted.store.all().find(record => record.key.includes("second"))!;
    expect((await restarted.client(resumed)).getServerCapabilities()?.tools).toBeDefined();
    expect(await f.stats()).toMatchObject({ authorizationGrants: 2, refreshGrants: 2, rejectedRefreshGrants: 0, revokedFamilies: 0 });
  });

  test.each(["wrong URL", "wrong client", "expired client", "malformed entry", "expired without refresh"])("does not transfer an unsafe grant: %s", async reason => {
    const f = await legacyFixture();
    const entry = structuredClone(f.entry);
    if (reason === "wrong URL") entry.serverUrl = "https://unrelated.example.com/mcp";
    if (reason === "wrong client") await addMcp(f.config, "ws_a", name, { ...f.settings, oauth: { clientId: "different-client" } });
    if (reason === "expired client") entry.clientInfo.clientSecretExpiresAt = 1;
    if (reason === "expired without refresh") { entry.tokens.refreshToken = undefined; entry.tokens.expiresAt = 1; }
    const source = { ...f.source, mock: reason === "malformed entry" ? { tokens: { accessToken: 1 } } : entry };
    await writeFile(f.authPath, JSON.stringify(source));
    const original = await readFile(f.authPath);
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([]);
    expect(await readFile(f.authPath)).toEqual(original);
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
    expect((await f.stats()).authorizationGrants).toBe(1);
  });

  test("same-name workspace connections are matched by provider URL without losing the other connection", async () => {
    const f = await legacyFixture();
    await addMcp(f.config, "ws_b", name, { ...f.settings, url: `${f.providerUrl}/another-account` }, "workspace");
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([name]);
    expect((await f.manager.find("ws_a", name))?.record.tokens?.access_token).toBe(f.entry.tokens.accessToken);
    expect((await f.manager.find("ws_b", name))?.record.config.url).toBe(`${f.providerUrl}/another-account`);
    expect((await f.manager.find("ws_b", name))?.record.tokens).toBeUndefined();
    expect((await (await f.connect()).listTools()).tools.length).toBeGreaterThan(0);
  });

  test("does not duplicate one old grant into independent workspace accounts", async () => {
    const f = await legacyFixture();
    await addMcp(f.config, "ws_b", name, f.settings, "workspace");
    expect((await migrateLegacyMcpOAuth(f.config, f.options)).migrated).toEqual([]);
    expect(f.manager.store.all().every(record => !record.tokens)).toBe(true);
    expect(JSON.parse(await readFile(f.authPath, "utf8"))).toEqual(f.source);
  });

  test("a corrupt old file defers transfer and is preserved without blocking startup", async () => {
    const f = await legacyFixture();
    await writeFile(f.authPath, "{broken");
    expect(await migrateLegacyMcpOAuth(f.config, f.options)).toEqual({ migrated: [], deferred: true });
    expect(await readFile(f.authPath, "utf8")).toBe("{broken");
    expect(f.manager.store.all()[0]?.tokens).toBeUndefined();
  });

  test("process inventory recognizes native engines without matching similar app names", () => {
    expect(hasOpencodeProcess("123 /Applications/LegalWork.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin\n", "darwin")).toBe(true);
    expect(hasOpencodeProcess("123 /usr/local/bin/opencode\n", "linux")).toBe(true);
    expect(hasOpencodeProcess("123 /usr/bin/node\n124 /Applications/Code.app/Contents/MacOS/Electron\n", "darwin")).toBe(false);
    expect(hasOpencodeProcess('"opencode-x64.exe","123","Console","1","2,000 K"', "win32")).toBe(true);
    expect(hasOpencodeProcess('"Code.exe","123","Console","1","2,000 K"', "win32")).toBe(false);
  });
});
