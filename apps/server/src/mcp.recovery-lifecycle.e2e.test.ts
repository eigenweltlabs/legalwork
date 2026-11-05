import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { startEmbeddedServer } from "./embedded.js";
import { OpenCode } from "@opencode/client";
import { beginNativeMcpOAuth, waitForNativeMcpOAuth } from "./native-mcp.test-support.js";
import { addMcp, listMcp } from "./mcp.js";
import type { ServerConfig } from "./types.js";

const repo = resolve(import.meta.dir, "../../..");
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN ?? process.env.OPENCODE_TEST_BINARY ?? join(repo, "apps/desktop/resources/sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");
if ((process.env.LEGALWORK_TEST_OPENCODE_BIN || process.env.OPENCODE_TEST_BINARY) && !existsSync(binary)) throw new Error("Explicit released OpenCode fixture binary does not exist");
const statuses = z.record(z.string(), z.object({ status: z.string() }));

async function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("No local port allocated");
  return port;
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setup(url: string, oauth: false | { callbackPort: number }) {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-recovery-lifecycle-"));
  const previous = { ...process.env };
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "LEGALWORK_RUNTIME_DB", "LEGALWORK_TOKEN_STORE", "LEGALWORK_STORAGE_STORE"]) process.env[key] = join(root, key);
  process.env.OPENCODE_DB = join(root, "engine.db");
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  process.env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  delete process.env.LEGALWORK_OPENCODE_BASE_URL;
  delete process.env.LEGALWORK_WORKSPACES;
  const directories = [join(root, "a"), join(root, "b")];
  const remote = { type: "remote", url, oauth, enabled: true, timeout: 2000 };
  for (const directory of directories) await mkdir(directory);
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "local-lifecycle", hostToken: "local-lifecycle-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
    workspaces: directories.map((path, index) => ({ id: index ? "b" : "a", name: "Synthetic project", path, preset: "starter", workspaceType: "local" })),
    authorizedRoots: directories, configPath: join(root, "server.json"), startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const close = async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  };
  try {
    await writeFile(config.configPath!, JSON.stringify({ workspaces: config.workspaces, authorizedRoots: directories }));
    await addMcp(config, "a", "notes", remote);
    server = await startEmbeddedServer({ host: "127.0.0.1", port: 0, workspaces: [], configPath: config.configPath, token: config.token, hostToken: config.hostToken,
      approvalMode: "auto", logRequests: false, manageOpencode: true, managedEngineSandbox: false, opencodeBin: binary });
    Object.assign(config, server.config);
    const appUrl = server.url;
    async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(appUrl + path, { method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response.status === 204 ? undefined : response.json();
    }
    const directClient = OpenCode.make({ baseUrl: config.opencodeBaseUrl!, headers: { authorization: `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}` } });
    const directory = (workspace: "a" | "b") => directories[workspace === "a" ? 0 : 1]!;
    const native = (workspace: "a" | "b") => OpenCode.make({ baseUrl: `${appUrl}/workspace/${workspace}/opencode`, headers: { authorization: `Bearer ${config.token}` } });
    const direct = async (workspace: "a" | "b", path: string) => {
      if (path !== "/mcp") throw new Error("Unsupported native fixture read");
      return Object.fromEntries((await directClient.mcp.list({ location: { directory: directory(workspace) } })).data.map(server => [server.name, server.status]));
    };
    const proxy = async (workspace: "a" | "b", path: string, _body?: unknown) => path === "/mcp"
      ? Object.fromEntries((await native(workspace).mcp.list({ location: { directory: directory(workspace) } })).data.map(server => [server.name, server.status]))
      : path === "/mcp/notes/disconnect" ? native(workspace).mcp.disconnect({ location: { directory: directory(workspace) }, server: "notes" }) : (() => { throw new Error("Unsupported native fixture control"); })();
    for (const workspace of ["a", "b"] satisfies Array<"a" | "b">) {
      const status = z.object({ directory: z.string(), plugins: z.array(z.object({ target: z.string() })) }).parse(await request(`/workspace/${workspace}/engine-project`));
      await request(`/workspace/${workspace}/engine-project/approve`, { directory: status.directory, pluginTargets: status.plugins.map(plugin => plugin.target) });
      await directClient.model.list({ location: { directory: directory(workspace) } });
      await waitFor(async () => statuses.parse(await direct(workspace, "/mcp")).notes?.status === "failed", "initial offline MCP state");
    }
    return { config, app: request, proxy, direct, native, directory, close };
  } catch (error) { await close(); throw error; }
}

for (const action of ["disable", "remove", "disconnect"]) test.skipIf(!existsSync(binary))(`an in-flight recovery cannot undo ${action}`, async () => {
  let offline = true, hold = false;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (offline) return new Response("Synthetic outage", { status: 503 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(await request.json());
    if (message.method === "initialize" && hold) { started.resolve(); await release.promise; }
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", description: "Synthetic echo", inputSchema: { type: "object", properties: {} } }] } : {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;
  let mutation: Promise<unknown> | undefined;
  try {
    fixture = await setup(provider.url.origin + "/mcp", false);
    offline = false; hold = true;
    await fixture.proxy("a", "/mcp");
    await started.promise;
    mutation = action === "disconnect" ? fixture.proxy("a", "/mcp/notes/disconnect", {})
      : fixture.app(`/workspace/a/mcp/notes${action === "disable" ? "/enabled" : ""}`, action === "disable" ? { enabled: false } : undefined, action === "disable" ? "POST" : "DELETE");
    const acknowledgedBeforeRelease = await Promise.race([mutation.then(() => true), Bun.sleep(100).then(() => false)]);
    release.resolve();
    await mutation;
    // A completed mutation is the barrier: no earlier recovery can finish later.
    const after = statuses.parse(await fixture.direct("a", "/mcp"));
    if (action === "remove") expect(after.notes).toBeUndefined();
    else expect(after.notes?.status).toBe("disabled");
    expect(acknowledgedBeforeRelease).toBe(false);
    if (action === "disable") expect((await listMcp(fixture.config, "a", fixture.config.workspaces[0].path)).find(item => item.name === "notes")?.config.enabled).toBe(false);
    if (action === "remove") expect(await listMcp(fixture.config, "a", fixture.config.workspaces[0].path)).toEqual([]);
  } finally {
    release.resolve();
    await mutation?.catch(() => {});
    await fixture?.close();
    provider.stop(true);
  }
}, 45_000);

for (const pollingWorkspace of ["a", "b"] satisfies Array<"a" | "b">) test.skipIf(!existsSync(binary))(`pending OAuth survives recovery polling from workspace ${pollingWorkspace}`, async () => {
  const port = await freePort(), callbackPort = await freePort();
  let offline = true, registrations = 0;
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (offline) return new Response("Synthetic outage", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/register") registrations++;
    url.port = String(port);
    return fetch(url, { method: request.method, headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(), redirect: "manual",
    }).catch(() => new Response("Provider unavailable", { status: 503 }));
  } });
  const mock = spawn("node", [join(repo, "scripts/mock-oauth-mcp-server.mjs")], {
    env: { ...process.env, PORT: String(port), ISSUER: relay.url.origin, AUTO_APPROVE: "1" }, stdio: "ignore",
  });
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok === true, "synthetic OAuth provider");
    fixture = await setup(relay.url.origin + "/mcp", { callbackPort });
    offline = false;
    const location = { directory: fixture.directory("a") };
    const flow = await beginNativeMcpOAuth(fixture.native("a"), location, "notes");
    if (!flow.url) throw new Error("Missing native authorization URL");
    const registeredBeforePolling = registrations;
    await fixture.proxy(pollingWorkspace, "/mcp");
    await Bun.sleep(500);
    const consent = await fetch(flow.url, { redirect: "follow" });
    expect(consent.ok).toBe(true);
    expect((await waitForNativeMcpOAuth(fixture.native("a"), location, flow)).status).toBe("complete");
    expect(registrations).toBe(registeredBeforePolling);
    await fixture.proxy("b", "/mcp");
    const current = fixture;
    await waitFor(async () => statuses.parse(await current.direct("b", "/mcp")).notes.status === "connected", "recovery after sign-in completes");
  } finally {
    await fixture?.close();
    mock.kill();
    relay.stop(true);
  }
}, 45_000);
