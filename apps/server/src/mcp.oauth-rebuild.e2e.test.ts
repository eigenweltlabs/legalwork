import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpOAuthCallbackBroker } from "../../desktop/electron/mcp-oauth-callback.mjs";

/**
 * Why LegalWork never rebuilds an engine instance while an MCP sign-in is in
 * flight — pinned against the real bundled engine.
 *
 * The engine keeps a sign-in's pending OAuth transport in one process-global
 * map keyed only by server name. auth/start registers a fresh OAuth client and
 * holds it in memory; any unauthenticated connect attempt for the same server
 * name (an instance rebuild, a hot-add, another workspace's instance being
 * built) replaces that map entry with a transport bound to the client stored
 * in mcp-auth.json — the one the very first connect attempt registered. When
 * that happens between auth/start and auth/callback, the code exchange runs
 * under a different client_id than the authorize request and the provider
 * rejects it: "The OAuth 2.0 Client ID from this request does not match the
 * one from the authorize request".
 *
 * LegalWork therefore defers the post-connect engine reload until sign-in ends
 * (connections/store.ts) and holds auto-reloads while an attempt is active
 * (shell/reload-coordinator.tsx). If a future engine makes these tests fail
 * because the callback succeeds, both guards can go.
 *
 * Skipped automatically when the opencode sidecar binary is not present.
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const sidecarDir = join(repoRoot, "apps/desktop/resources/sidecars");

function findSidecar(): string | null {
  if (process.env.OPENCODE_TEST_BINARY) {
    if (!existsSync(process.env.OPENCODE_TEST_BINARY)) throw new Error("OPENCODE_TEST_BINARY does not exist");
    return process.env.OPENCODE_TEST_BINARY;
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const names =
    process.platform === "darwin"
      ? [`opencode-${arch}-apple-darwin`]
      : process.platform === "linux"
        ? [`opencode-${arch}-unknown-linux-gnu`, `opencode-${arch}-unknown-linux-musl`]
        : [];
  for (const name of names) {
    const candidate = join(sidecarDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const enginePath = findSidecar();
const describeMaybe = enginePath ? describe : describe.skip;

const MCP_NAME = "fibery-like";

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to allocate a free port");
  return port;
}

describeMaybe("engine OAuth pending state vs. instance rebuilds and other workspaces", () => {
  let mockProc: ChildProcess;
  let engineProc: ChildProcess;
  let mockPort = 0;
  let enginePort = 0;
  let callbackPort = 0;
  let workDirA = "";
  let workDirB = "";
  let dataDir = "";
  const callbacks = createMcpOAuthCallbackBroker();

  const mockUrl = () => `http://127.0.0.1:${mockPort}`;
  const engineUrl = () => `http://127.0.0.1:${enginePort}`;

  async function engineFetch(directory: string, path: string, init?: RequestInit) {
    const url = new URL(`${engineUrl()}${path}`);
    url.searchParams.set("directory", directory);
    return fetch(url, init);
  }

  async function registrations(): Promise<number> {
    const log = (await (await fetch(`${mockUrl()}/requests`)).json()) as { requests: Array<{ method: string; path: string }> };
    return log.requests.filter((r) => r.path === "/register").length;
  }

  function storedClientId(): string | undefined {
    const file = join(dataDir, "xdg-data", "opencode", "mcp-auth.json");
    if (!existsSync(file)) return undefined;
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { clientInfo?: { clientId?: string } }>;
    return saved[MCP_NAME]?.clientInfo?.clientId;
  }

  function writeConfig(dir: string) {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { [MCP_NAME]: { type: "remote", url: `${mockUrl()}/mcp`, enabled: true, oauth: { callbackPort } } },
      }),
    );
  }

  /** auth/start, returning the authorization URL and the client_id it carries. */
  async function startAuth(directory: string) {
    const res = await engineFetch(directory, `/mcp/${MCP_NAME}/auth`, { method: "POST" });
    expect(res.ok).toBe(true);
    const started = (await res.json()) as { authorizationUrl: string; oauthState: string };
    const url = new URL(started.authorizationUrl);
    return { url, clientId: url.searchParams.get("client_id")!, state: url.searchParams.get("state")! };
  }

  /** The desktop app binds the loopback callback BEFORE auth/start, so the engine skips its own listener. */
  async function listen() {
    return callbacks.listen({ redirectUri: `http://127.0.0.1:${callbackPort}/mcp/oauth/callback` });
  }

  /** Play the browser: approve at the provider and deliver the callback to the desktop broker. */
  async function approveInBrowser(listenerId: string, url: URL, state: string) {
    const waiting = callbacks.wait({ listenerId, state });
    const authorizeRes = await fetch(url, { redirect: "manual" });
    expect(authorizeRes.status).toBe(302);
    const callbackUrl = authorizeRes.headers.get("location")!;
    expect((await fetch(callbackUrl)).ok).toBe(true);
    return waiting;
  }

  async function completeAuth(directory: string, code: string) {
    const res = await engineFetch(directory, `/mcp/${MCP_NAME}/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(res.ok).toBe(true);
    return (await res.json()) as { status: string; error?: string };
  }

  async function logout(directory: string) {
    await engineFetch(directory, `/mcp/${MCP_NAME}/disconnect`, { method: "POST" });
    await engineFetch(directory, `/mcp/${MCP_NAME}/auth`, { method: "DELETE" });
  }

  beforeAll(async () => {
    mockPort = await getFreePort();
    enginePort = await getFreePort();
    callbackPort = await getFreePort();
    workDirA = mkdtempSync(join(tmpdir(), "mcp-oauth-ws-a-"));
    workDirB = mkdtempSync(join(tmpdir(), "mcp-oauth-ws-b-"));
    dataDir = mkdtempSync(join(tmpdir(), "mcp-oauth-data-"));
    writeConfig(workDirA);
    writeConfig(workDirB);

    mockProc = spawn("node", [join(repoRoot, "scripts/mock-oauth-mcp-server.mjs")], {
      env: { ...process.env, PORT: String(mockPort), AUTO_APPROVE: "1" },
      stdio: "ignore",
    });
    await waitFor(async () => ((await fetch(`${mockUrl()}/health`)).ok ? true : null), 10_000, "mock oauth server");

    const engineEnv = { ...process.env };
    for (const key of Object.keys(engineEnv)) if (key.startsWith("OPENCODE_")) delete engineEnv[key];
    engineProc = spawn(enginePath!, ["serve", "--hostname", "127.0.0.1", "--port", String(enginePort)], {
      cwd: workDirA,
      env: {
        ...engineEnv,
        XDG_DATA_HOME: join(dataDir, "xdg-data"),
        XDG_CONFIG_HOME: join(dataDir, "xdg-config"),
        XDG_STATE_HOME: join(dataDir, "xdg-state"),
        XDG_CACHE_HOME: join(dataDir, "xdg-cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: "ignore",
    });
    await waitFor(async () => ((await engineFetch(workDirA, "/mcp")).ok ? true : null), 30_000, "opencode engine");
  }, 60_000);

  afterAll(() => {
    callbacks.close();
    engineProc?.kill();
    mockProc?.kill();
    rmSync(workDirA, { recursive: true, force: true });
    rmSync(workDirB, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("control: an undisturbed sign-in completes", async () => {
    const listener = await listen();
    const { url, clientId, state } = await startAuth(workDirA);
    const { code } = await approveInBrowser(listener.listenerId, url, state);
    const result = await completeAuth(workDirA, code);
    expect(result).toEqual({ status: "connected" });
    expect(storedClientId()).toBe(clientId);
    await logout(workDirA);
  }, 60_000);

  test("an instance rebuild (what the app's auto-reload does) between browser open and callback breaks the exchange", async () => {
    const listener = await listen();
    const before = await registrations();
    const { url, clientId, state } = await startAuth(workDirA);
    // auth/start ALWAYS registers a fresh client (its pending provider ignores the stored one).
    expect(await registrations()).toBe(before + 1);

    // The app marks "reload required" right after connect; the reload
    // coordinator disposes the instance ~1.5s later while the user is still in
    // the browser. Same thing here, explicitly.
    const dispose = await engineFetch(workDirA, "/instance/dispose", { method: "POST" });
    expect(dispose.ok).toBe(true);
    await waitFor(
      async () => {
        const statuses = (await (await engineFetch(workDirA, "/mcp")).json()) as Record<string, { status: string }>;
        return statuses[MCP_NAME]?.status === "needs_auth" ? statuses : null;
      },
      30_000,
      "rebuilt instance to finish its own connect attempt",
    );
    // The rebuilt instance's connect attempt replaced the pending sign-in with a
    // transport bound to the client stored in mcp-auth.json (registered by the
    // very first unauthenticated connect) — not the one the browser was sent with.
    expect(storedClientId()).toBeDefined();
    expect(storedClientId()).not.toBe(clientId);

    const { code } = await approveInBrowser(listener.listenerId, url, state);
    const result = await completeAuth(workDirA, code);
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toMatch(/another client|invalid_grant|client/i);
    await logout(workDirA);
  }, 90_000);

  test("another workspace's instance connecting the same server name clobbers a pending sign-in", async () => {
    const listener = await listen();
    const { url, clientId, state } = await startAuth(workDirA);

    // Workspace B has the same connector in its config (that is what a global
    // runtime config gives every workspace). Merely building B's instance —
    // the user switching to it, or the server syncing MCPs into it — runs an
    // unauthenticated connect for the same server name.
    await waitFor(
      async () => {
        const statuses = (await (await engineFetch(workDirB, "/mcp")).json()) as Record<string, { status: string }>;
        return statuses[MCP_NAME]?.status === "needs_auth" ? statuses : null;
      },
      30_000,
      "workspace B instance to finish its own connect attempt",
    );
    expect(storedClientId()).toBeDefined();
    expect(storedClientId()).not.toBe(clientId);

    const { code } = await approveInBrowser(listener.listenerId, url, state);
    const result = await completeAuth(workDirA, code);
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toMatch(/another client|invalid_grant|client/i);
  }, 90_000);
});
