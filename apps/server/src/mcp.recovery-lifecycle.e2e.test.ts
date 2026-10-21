import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { listMcp } from "./mcp.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const repo = resolve(import.meta.dir, "../../..");
const target = process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc.exe" : "unknown-linux-gnu";
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const binary = process.env.OPENCODE_TEST_BINARY ?? join(repo, "apps/desktop/resources/sidecars", `opencode-${arch}-${target}`);
if (process.env.OPENCODE_TEST_BINARY && !existsSync(binary)) throw new Error("OPENCODE_TEST_BINARY does not exist");
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
  const root = await mkdtemp(join(tmpdir(), "legalwork-recovery-lifecycle-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const directories = [join(root, "a"), join(root, "b")];
  const remote = { type: "remote", url, oauth, enabled: true, timeout: 2000 };
  for (const directory of directories) {
    await mkdir(directory);
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
      mcp: {}, plugin: [], autoupdate: false, lsp: false, formatter: false,
    }));
  }
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "local-lifecycle", hostToken: "local-lifecycle-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
    workspaces: directories.map((path, index) => ({ id: index ? "b" : "a", name: "Synthetic project", path, preset: "starter", workspaceType: "local" })),
    authorizedRoots: directories, configPath: join(root, "server.json"), startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const close = async () => {
    await server?.stop();
    await engine?.close();
    await rm(root, { recursive: true, force: true });
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  };
  try {
    const engineConfig = join(directories[0], "opencode.jsonc");
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directories[0], timeoutMs: 30_000, env: {
      OPENCODE_CONFIG: engineConfig, OPENCODE_CONFIG_CONTENT: "", OPENCODE_CONFIG_DIR: join(root, "policy"),
      OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "engine.db"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    } });
    config.opencodeBaseUrl = engine.url;
    config.opencodeUsername = engine.username;
    config.opencodePassword = engine.password;
    server = await startServer(config);
    const engineUrl = engine.url;
    const engineAuthorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`;
    const appUrl = `http://127.0.0.1:${server.port}`;
    async function request(base: string, path: string, authorization: string, body?: unknown, method = body === undefined ? "GET" : "POST", extraHeaders: Record<string, string> = {}) {
      const response = await fetch(base + path, { method, headers: { authorization, "content-type": "application/json", ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response.json();
    }
    const direct = (workspace: "a" | "b", path: string) => request(engineUrl, `${path}?directory=${encodeURIComponent(directories[workspace === "a" ? 0 : 1])}`, engineAuthorization);
    const app = (path: string, body?: unknown, method?: string, headers?: Record<string, string>) => request(appUrl, path, `Bearer ${config.token}`, body, method, headers);
    const proxy = (workspace: "a" | "b", path: string, body?: unknown, headers?: Record<string, string>) => app(`/workspace/${workspace}/opencode${path}`, body, undefined, headers);
    await app("/workspace/a/mcp", { name: "notes", config: remote });
    for (const workspace of ["a", "b"] satisfies Array<"a" | "b">) {
      expect(statuses.parse(await direct(workspace, "/mcp")).notes.status).toBe("failed");
    }
    return { config, app, proxy, direct, close };
  } catch (error) { await close(); throw error; }
}

for (const action of ["disable", "remove", "disconnect"]) test.skipIf(!existsSync(binary))(`an in-flight recovery cannot undo ${action}`, async () => {
  let offline = true, hold = false;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (offline) return new Response("Synthetic outage", { status: 503 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(await request.json());
    if (message.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Legacy fixture: discovery is not supported" } });
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
    // Allow the manager’s short transport cooldown from the initial outage to
    // expire before asking the engine to replace its failed gateway session.
    await Bun.sleep(3100);
    expect(statuses.parse(await fixture.proxy("a", "/mcp")).notes.status).toBe("connecting");
    await started.promise;
    mutation = action === "disconnect" ? fixture.proxy("a", "/mcp/notes/disconnect", {})
      : fixture.app(`/workspace/a/mcp/notes${action === "disable" ? "/enabled" : ""}`, action === "disable" ? { enabled: false } : undefined, action === "disable" ? "POST" : "DELETE");
    await Promise.race([mutation, Bun.sleep(100)]);
    release.resolve();
    await mutation;
    // The manager may cancel the old handshake immediately. After its delayed
    // response is released, it must not restore the retired engine connection.
    expect(statuses.parse(await fixture.direct("a", "/mcp")).notes.status).toBe("disabled");
    await Bun.sleep(100);
    expect(statuses.parse(await fixture.direct("a", "/mcp")).notes.status).toBe("disabled");
    if (action !== "disconnect") expect(statuses.parse(await fixture.direct("b", "/mcp")).notes.status).not.toBe("connected");
    if (action === "disable") expect(statuses.parse(await fixture.proxy("b", "/mcp")).notes.status).toBe("disabled");
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
    const flow = z.object({ authorizationUrl: z.string() }).parse(await fixture.proxy("a", "/mcp/notes/auth", {}));
    expect(statuses.parse(await fixture.direct("a", "/mcp")).notes.status).toBe("failed");
    const registeredBeforePolling = registrations;
    await fixture.proxy(pollingWorkspace, "/mcp");
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && registrations === registeredBeforePolling) await Bun.sleep(10);
    const consent = await fetch(flow.authorizationUrl, { redirect: "manual" });
    const redirect = consent.headers.get("location");
    if (!redirect) throw new Error("Synthetic authorization did not return a code");
    const callback = new URL(redirect);
    expect(await fixture.proxy("a", "/mcp/notes/auth/callback", { code: callback.searchParams.get("code") }, {
      "x-legalwork-oauth-state": callback.searchParams.get("state") ?? "",
      ...(callback.searchParams.has("iss") ? { "x-legalwork-oauth-issuer": callback.searchParams.get("iss")! } : {}),
    })).toEqual({ status: "connected" });
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
