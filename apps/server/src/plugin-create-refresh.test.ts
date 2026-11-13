import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import * as globalLibrary from "./managed-global-library.js";
import * as systemOne from "./systemone.js";
import { keepLegalworkRuntimeConfigFileFresh, legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, managedEngineSettingsFilePath, publishRuntimeConfigChanges, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { readManagedEngineSettings } from "./managed-engine-settings.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { waitForNativeFixture } from "./native-mcp.test-support.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { createdPluginId, parsePluginCreateRequest, planPluginCreation } from "./plugin-create.js";
import { installPluginImport } from "./plugin-import-install.js";
import { withPluginImportLock } from "./plugin-imports.js";
import { closeRuntimeOpencodeConfig, GLOBAL_MCP_ID, onRuntimeOpencodeConfigWrite, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

async function fixture(run: (config: ServerConfig) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-plugin-create-refresh-"))), previous = { ...process.env };
  Object.assign(process.env, { LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite"), LEGALWORK_ENV_STORE: join(root, "env.json"), LEGALWORK_TOKEN_STORE: join(root, "tokens.json"), XDG_CONFIG_HOME: join(root, "config"), CLAUDE_CONFIG_DIR: join(root, "claude") });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  for (let index = 0; index < 11; index++) {
    const path = join(root, `project-${index}`); await mkdir(path);
    config.workspaces.push({ id: `ws_${index}`, name: `Project ${index}`, path, preset: "starter", workspaceType: "local" });
    config.authorizedRoots.push(path);
  }
  try { await run(config); }
  finally {
    await closeRuntimeOpencodeConfig(config);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}

for (const kind of ["plugin", "connector"]) test(`creating a custom ${kind} publishes once and preserves its project refresh barrier`, async () => fixture(async config => {
  const origin = config.workspaces[0]!;
  const refreshed: string[] = [];
  let releaseOther = () => {}, notifyOther = () => {};
  const otherBlocked = new Promise<void>(resolve => { releaseOther = resolve; });
  const otherRequested = new Promise<void>(resolve => { notifyOther = resolve; });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") return Response.json([]);
    if (url.pathname === "/api/rpc/legalwork.managed-settings/refresh") {
      const directory = url.searchParams.get("location[directory]") ?? "";
      refreshed.push(directory);
      // Resolve only when every refresh has started: a serial loop would
      // deadlock on the blocked projects, and early success wins the race.
      if (refreshed.length === config.workspaces.length) notifyOther();
      if (directory !== origin.path) {
        await otherBlocked;
      }
      const settings = await readManagedEngineSettings(managedEngineSettingsFilePath(config), directory);
      expect(Object.keys(settings.configuration.mcp?.servers ?? {})).toHaveLength(1);
      return Response.json({ refreshed: true });
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  } });
  for (const workspace of config.workspaces) workspace.baseUrl = engine.url.href;
  const server = await startServer(config);
  const stopWatching = keepLegalworkRuntimeConfigFileFresh(config, origin.id);
  const publish = spyOn(globalLibrary, "prepareManagedGlobalLibrary");
  let request: Promise<Response> | undefined;
  try {
    const connector = { type: "remote", url: "https://example.invalid/mcp", oauth: false };
    request = fetch(`http://127.0.0.1:${server.port}/workspace/${origin.id}/${kind === "plugin" ? "workflow-plugins" : "mcp"}`, {
      method: "POST", headers: { authorization: "Bearer test", "x-legalwork-host-token": "host", "content-type": "application/json" },
      body: JSON.stringify(kind === "plugin"
        ? { name: "Fast custom connector", skills: [], connectors: [], newConnector: connector }
        : { name: "fast-custom-connector", config: connector }),
      signal: AbortSignal.timeout(15_000),
    });
    const first = await Promise.race([request.then(response => ({ response })), otherRequested.then(() => ({ response: null }))]);
    if (kind === "plugin") expect(first.response, "Plugin creation keeps its existing current-project refresh").not.toBeNull();
    else expect(first.response, "Shared connector Add must wait for every project refresh").toBeNull();
    expect(refreshed.sort()).toEqual((kind === "plugin" ? [origin.path] : config.workspaces.map(workspace => workspace.path)).sort());
    releaseOther();
    const response = first.response ?? await request;
    expect(response.status, await response.text()).toBe(200);
    await stopWatching();
    expect(publish).toHaveBeenCalledTimes(1);
    for (const workspace of config.workspaces) {
      const settings = await readManagedEngineSettings(managedEngineSettingsFilePath(config), workspace.path);
      expect(Object.values(settings.configuration.mcp?.servers ?? {})).toContainEqual(expect.objectContaining({ type: "remote", url: "https://example.invalid/mcp" }));
    }
  } finally {
    releaseOther(); await request?.catch(() => undefined);
    await stopWatching(); publish.mockRestore(); await server.stop(); engine.stop(true);
  }
}), 30_000);

test("connector Add waits for an overlapping library publication before refreshing projects", async () => fixture(async config => {
  const origin = config.workspaces[0]!;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), refreshed = Promise.withResolvers<void>();
  const observed: string[][] = [];
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") return Response.json([]);
    if (url.pathname === "/api/rpc/legalwork.managed-settings/refresh") {
      const settings = await readManagedEngineSettings(managedEngineSettingsFilePath(config), url.searchParams.get("location[directory]") ?? "");
      observed.push(Object.keys(settings.configuration.mcp?.servers ?? {}));
      refreshed.resolve();
      return Response.json({ refreshed: true });
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  } });
  for (const workspace of config.workspaces) workspace.baseUrl = engine.url.href;
  const server = await startServer(config);
  const stopWatching = keepLegalworkRuntimeConfigFileFresh(config, origin.id);
  await writeLegalworkRuntimeConfigFile(config, origin.id);
  const held = withPluginImportLock(() => publishRuntimeConfigChanges(config, origin.id, async () => {
    entered.resolve();
    await release.promise;
  }));
  let request: Promise<Response> | undefined;
  try {
    await entered.promise;
    request = fetch(`http://127.0.0.1:${server.port}/workspace/${origin.id}/mcp`, {
      method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "concurrent", config: { type: "remote", url: "https://example.invalid/mcp", oauth: false } }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(await Promise.race([
      request.then(() => "returned"), refreshed.promise.then(() => "refreshed"), Bun.sleep(100).then(() => "pending"),
    ])).toBe("pending");
    release.resolve();
    await held;
    const response = await request;
    expect(response.status, await response.text()).toBe(200);
    expect(observed).toEqual(config.workspaces.map(() => ["concurrent"]));
  } finally {
    release.resolve(); await held; await request?.catch(() => undefined);
    await stopWatching(); await server.stop(); engine.stop(true);
  }
}), 30_000);

test("removing a shared plugin publishes everywhere without contacting any project engine", async () => fixture(async config => {
  const origin = config.workspaces[0]!;
  await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: { retained: { type: "remote", url: "https://example.invalid/retained", disabled: true } } } }));
  const input = parsePluginCreateRequest({ name: "Remove fixture", skills: [], connectors: [], newConnector: { type: "remote", url: "https://example.invalid/removed", oauth: false } });
  await installPluginImport(config, origin.id, origin.path, await planPluginCreation(config, origin.path, input), true);
  const refreshed: string[] = [];
  let releaseOther = () => {}, notifyOther = () => {};
  const otherBlocked = new Promise<void>(resolve => { releaseOther = resolve; });
  const otherRequested = new Promise<void>(resolve => { notifyOther = resolve; });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rpc/legalwork.managed-settings/refresh") {
      const directory = url.searchParams.get("location[directory]") ?? "";
      refreshed.push(directory);
      notifyOther(); await otherBlocked;
      return Response.json({ refreshed: true });
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  } });
  for (const workspace of config.workspaces) workspace.baseUrl = engine.url.href;
  const server = await startServer(config);
  const stopWatching = keepLegalworkRuntimeConfigFileFresh(config, origin.id);
  const publish = spyOn(globalLibrary, "prepareManagedGlobalLibrary");
  const readiness = spyOn(systemOne, "readSystemOneSettings");
  let request: Promise<Response> | undefined;
  try {
    const base = `http://127.0.0.1:${server.port}/workspace/${origin.id}/cloud-plugins`;
    const headers = { authorization: "Bearer test", "x-legalwork-host-token": "host" };
    request = fetch(`${base}/${encodeURIComponent(createdPluginId(input.name))}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
    const first = await Promise.race([request.then(response => ({ response })), otherRequested.then(() => ({ response: null }))]);
    expect(first.response, "Removal must finish without contacting any project engine").not.toBeNull();
    expect(first.response?.status).toBe(200);
    expect(refreshed).toEqual([]);
    await stopWatching();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(await (await fetch(base, { headers })).json()).toMatchObject({ plugins: {} });
    for (const workspace of config.workspaces) {
      const settings = await readManagedEngineSettings(managedEngineSettingsFilePath(config), workspace.path);
      expect(Object.keys(settings.configuration.mcp?.servers ?? {})).toEqual(["retained"]);
    }
  } finally {
    releaseOther(); await request?.catch(() => undefined);
    await stopWatching(); publish.mockRestore(); readiness.mockRestore(); await server.stop(); engine.stop(true);
  }
}), 30_000);

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
for (const kind of ["plugin", "connector"]) test.skipIf(!binary)(`created and removed ${kind}s reach loaded and unopened native projects`, async () => fixture(async config => {
  if (!binary) throw new Error("Released engine binary is required");
  const origin = config.workspaces[0]!, loaded = config.workspaces[1]!, unopened = config.workspaces[2]!;
  const root = dirname(origin.path);
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string() }).parse(await request.json());
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", description: "Fixture echo", inputSchema: { type: "object", properties: {} } }] } : {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let stopWatching: (() => Promise<void>) | undefined;
  try {
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: { retained: { type: "remote", url: `${mcp.url}mcp`, oauth: false } } } }));
    await writeLegalworkRuntimeConfigFile(config, origin.id);
    server = await startServer(config);
    engine = await createManagedOpencodeServer({ bin: binary, cwd: root, timeoutMs: 30_000, parentLease: true, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "engine-config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config), OPENCODE_CONFIG: legalworkRuntimeConfigFilePath(config), OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config), OPENCODE_DB: join(root, "engine.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", LEGALWORK_SERVER_URL: `http://127.0.0.1:${server.port}`, LEGALWORK_SERVER_TOKEN: config.token,
    } });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    for (const workspace of [origin, loaded]) {
      await waitForNativeFixture(() => client.model.list({ location: { directory: workspace.path } }), () => true, `native project activation in ${workspace.id}`);
      await waitForNativeFixture(async () => (await client.plugin.list({ location: { directory: workspace.path } })).data,
        plugins => plugins.some(plugin => plugin.id === "opencode.config.mcp" && plugin.state.status === "active"), `active MCP configuration in ${workspace.id}`);
      await waitForNativeFixture(async () => (await client.mcp.list({ location: { directory: workspace.path } })).data,
        entries => entries.length === 1 && entries[0]?.name === "retained", `retained connector in ${workspace.id}`);
    }
    stopWatching = keepLegalworkRuntimeConfigFileFresh(config, origin.id);
    // Native connector Add and removal refresh all 11 projects, including cold
    // projects. Allow CI cold starts without weakening the refresh barrier checks.
    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${origin.id}/${kind === "plugin" ? "workflow-plugins" : "mcp"}`, {
      method: "POST", headers: { authorization: "Bearer test", "x-legalwork-host-token": "host", "content-type": "application/json" },
      body: JSON.stringify(kind === "plugin"
        ? { name: "Native custom connector", skills: [], connectors: [], newConnector: { type: "remote", url: `${mcp.url}mcp`, oauth: false } }
        : { name: "native-custom-connector", config: { type: "remote", url: `${mcp.url}mcp`, oauth: false } }),
      signal: AbortSignal.timeout(60_000),
    }).catch(cause => { throw new Error(`Native ${kind} creation across ${config.workspaces.length} projects failed`, { cause }); });
    expect(response.status, await response.text()).toBe(200);
    for (const workspace of [origin, loaded, unopened]) {
      // Opening a cold project activates its native plugin registrations.
      if (workspace === unopened) await waitForNativeFixture(() => client.model.list({ location: { directory: workspace.path } }), () => true, `native project activation in ${workspace.id}`);
      const connectors = await waitForNativeFixture(async () => (await client.mcp.list({ location: { directory: workspace.path } })).data,
        entries => entries.length === 2 && entries.every(entry => entry.status.status === "connected"), `connected plugin in ${workspace.id}`);
      expect(connectors).toHaveLength(2);
    }
    const removed = await fetch(`http://127.0.0.1:${server.port}/workspace/${origin.id}/${kind === "plugin" ? `cloud-plugins/${encodeURIComponent(createdPluginId("Native custom connector"))}` : "mcp/native-custom-connector"}`, {
      method: "DELETE", headers: { authorization: "Bearer test", "x-legalwork-host-token": "host" }, signal: AbortSignal.timeout(60_000),
    }).catch(cause => { throw new Error(`Native ${kind} removal across ${config.workspaces.length} projects failed`, { cause }); });
    expect(removed.status, await removed.text()).toBe(200);
    for (const workspace of [origin, loaded, unopened, config.workspaces[3]!]) {
      if (workspace === config.workspaces[3]) await waitForNativeFixture(() => client.model.list({ location: { directory: workspace.path } }), () => true, `native project activation in ${workspace.id}`);
      const connectors = await waitForNativeFixture(async () => (await client.mcp.list({ location: { directory: workspace.path } })).data,
        entries => entries.length === 1 && entries[0]?.name === "retained", `removed plugin in ${workspace.id}`);
      expect(connectors.map(entry => entry.name)).toEqual(["retained"]);
    }
    await publishRuntimeConfigChanges(config, origin.id, () => writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: {} } })));
    for (const workspace of [origin, loaded, unopened, config.workspaces[4]!]) {
      if (workspace === config.workspaces[4]) await waitForNativeFixture(() => client.model.list({ location: { directory: workspace.path } }), () => true, `native project activation in ${workspace.id}`);
      const connectors = await waitForNativeFixture(async () => (await client.mcp.list({ location: { directory: workspace.path } })).data,
        entries => entries.length === 0, `last connector removed in ${workspace.id}`);
      expect(connectors).toEqual([]);
    }
  } finally { await stopWatching?.(); await engine?.close(); await server?.stop(); mcp.stop(true); }
}), 180_000);

test("batched publication retains rollback and normal write notifications", async () => fixture(async config => {
  const stopWatching = keepLegalworkRuntimeConfigFileFresh(config, "ws_0");
  let notifications = 0;
  const stopObserving = onRuntimeOpencodeConfigWrite(() => { notifications++; });
  const publish = spyOn(globalLibrary, "prepareManagedGlobalLibrary");
  try {
    await expect(publishRuntimeConfigChanges(config, "ws_0", async () => {
      await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: { temporary: { type: "remote", url: "https://example.invalid/mcp" } } } }));
      await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: {} } }));
      throw new Error("Installation rolled back");
    })).rejects.toThrow("Installation rolled back");
    expect(notifications).toBe(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await readManagedEngineSettings(managedEngineSettingsFilePath(config), config.workspaces[0]!.path)).configuration.mcp?.servers ?? {}).toEqual({});
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: { next: { type: "remote", url: "https://example.invalid/next" } } } }));
    await stopWatching();
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await readManagedEngineSettings(managedEngineSettingsFilePath(config), config.workspaces[0]!.path)).configuration.mcp?.servers?.next).toBeDefined();
  } finally { await stopWatching(); stopObserving(); publish.mockRestore(); }
}), 30_000);
