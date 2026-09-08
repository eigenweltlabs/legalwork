import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpOAuthCallbackBroker } from "../../desktop/electron/mcp-oauth-callback.mjs";

/**
 * Full MCP OAuth flow e2e:
 *
 *   real opencode engine (sidecar binary)
 *     -> mock OAuth MCP server (scripts/mock-oauth-mcp-server.mjs)
 *     -> discovery + dynamic client registration + PKCE (S256)
 *     -> authorization redirect ("the browser")
 *     -> token exchange (PKCE verified by the mock)
 *     -> authenticated streamable-HTTP MCP connect (tools/list)
 *
 * The test plays the role of the user's browser by following the
 * authorization URL and the resulting redirect to the engine's loopback
 * callback broker, then delivers the code to the engine. This is the same flow the LegalWork desktop app drives through
 * the OAuth modal (apps/app .../connections/mcp-auth-modal.tsx).
 *
 * Skipped automatically when the opencode sidecar binary is not present
 * (e.g. CI runners that never ran prepare:sidecar).
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

const MCP_NAME = "mock-oauth-flow";

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

describeMaybe("mcp oauth flow against mock provider", () => {
  let mockProc: ChildProcess;
  let engineProc: ChildProcess;
  let mockPort = 0;
  let enginePort = 0;
  let callbackPort = 0;
  let workDir = "";
  let dataDir = "";

  const mockUrl = () => `http://127.0.0.1:${mockPort}`;
  const engineUrl = () => `http://127.0.0.1:${enginePort}`;
  const callbacks = createMcpOAuthCallbackBroker();

  async function engineFetch(path: string, init?: RequestInit) {
    const url = new URL(`${engineUrl()}${path}`);
    url.searchParams.set("directory", workDir);
    return fetch(url, init);
  }

  beforeAll(async () => {
    mockPort = await getFreePort();
    enginePort = await getFreePort();
    callbackPort = await getFreePort();

    workDir = mkdtempSync(join(tmpdir(), "mcp-oauth-ws-"));
    dataDir = mkdtempSync(join(tmpdir(), "mcp-oauth-data-"));
    writeFileSync(
      join(workDir, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [MCP_NAME]: { type: "remote", url: `${mockUrl()}/mcp`, enabled: true, oauth: { callbackPort } },
        },
      }),
    );

    mockProc = spawn("node", [join(repoRoot, "scripts/mock-oauth-mcp-server.mjs")], {
      env: { ...process.env, PORT: String(mockPort), AUTO_APPROVE: "1" },
      stdio: "ignore",
    });
    await waitFor(
      async () => {
        const res = await fetch(`${mockUrl()}/health`);
        return res.ok ? true : null;
      },
      10_000,
      "mock oauth server",
    );

    // Never inherit the running desktop's config, plugins, or authentication.
    const engineEnv = { ...process.env };
    for (const key of Object.keys(engineEnv)) {
      if (key.startsWith("OPENCODE_")) delete engineEnv[key];
    }
    engineProc = spawn(enginePath!, ["serve", "--hostname", "127.0.0.1", "--port", String(enginePort)], {
      cwd: workDir,
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
    await waitFor(
      async () => {
        const res = await engineFetch("/mcp");
        return res.ok ? true : null;
      },
      30_000,
      "opencode engine",
    );
  }, 60_000);

  afterAll(() => {
    callbacks.close();
    engineProc?.kill();
    mockProc?.kill();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "engine completes browser OAuth (discovery, DCR, PKCE) and connects",
    async () => {
      // Initially the MCP requires auth.
      const before = (await (await engineFetch("/mcp")).json()) as Record<string, { status: string }>;
      expect(before[MCP_NAME]).toBeDefined();
      expect(before[MCP_NAME].status).not.toBe("connected");

      // Reserve the callback before auth/start. The engine skips its own
      // listener when the desktop already owns this port.
      const listener = await callbacks.listen({
        redirectUri: `http://127.0.0.1:${callbackPort}/mcp/oauth/callback`,
      });

      // Start the OAuth flow: engine performs discovery + dynamic client
      // registration and hands back the authorization URL it would open
      // in the user's browser.
      const startRes = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "POST" });
      expect(startRes.ok).toBe(true);
      const started = (await startRes.json()) as { authorizationUrl?: string; url?: string };
      const authorizationUrl = started.authorizationUrl ?? started.url;
      expect(authorizationUrl).toBeTruthy();
      const authUrl = new URL(authorizationUrl!);
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authUrl.searchParams.get("state")).toBeTruthy();
      const callback = callbacks.wait({ listenerId: listener.listenerId, state: authUrl.searchParams.get("state")! });

      // Play the browser: visit the authorization URL. The mock
      // auto-approves and 302s to the engine's loopback callback.
      const authorizeRes = await fetch(authorizationUrl!, { redirect: "manual" });
      expect(authorizeRes.status).toBe(302);
      const callbackUrl = authorizeRes.headers.get("location");
      expect(callbackUrl).toBeTruthy();
      const cb = new URL(callbackUrl!);
      expect(cb.searchParams.get("code")).toBeTruthy();
      expect(cb.searchParams.get("state")).toBe(authUrl.searchParams.get("state"));

      // A failed browser callback is a test failure, never hidden by fallback.
      const browserCallback = await fetch(callbackUrl!);
      expect(browserCallback.ok).toBe(true);
      const received = await callback;
      const expectedCode = cb.searchParams.get("code");
      if (!expectedCode) throw new Error("Provider callback did not include an authorization code");
      expect(received.code).toBe(expectedCode);
      const complete = await engineFetch(`/mcp/${MCP_NAME}/auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(received),
      });
      expect(complete.ok).toBe(true);
      expect(await complete.json()).toEqual({ status: "connected" });

      // The engine exchanges the code (mock verifies PKCE) and connects.
      const connected = await waitFor(
        async () => {
          const res = await engineFetch("/mcp");
          if (!res.ok) return null;
          const statuses = (await res.json()) as Record<string, { status: string }>;
          return statuses[MCP_NAME]?.status === "connected" ? statuses : null;
        },
        30_000,
        "mcp connected status",
      );
      expect(connected[MCP_NAME].status).toBe("connected");

      // Tokens are persisted for reuse across restarts.
      const authFile = join(dataDir, "xdg-data", "opencode", "mcp-auth.json");
      expect(existsSync(authFile)).toBe(true);
      const saved = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { tokens?: { accessToken?: string } }>;
      expect(saved[MCP_NAME]?.tokens?.accessToken).toStartWith("mock-access-");

      // The mock saw the full, authenticated MCP handshake.
      const log = (await (await fetch(`${mockUrl()}/requests`)).json()) as {
        requests: Array<{ method: string; path: string }>;
      };
      const paths = log.requests.map((r) => `${r.method} ${r.path}`);
      expect(paths).toContain("POST /register");
      expect(paths).toContain("GET /authorize");
      expect(paths).toContain("POST /token");
      expect(paths).toContain("POST /mcp");
    },
    90_000,
  );

  test("logout removes stored tokens and drops the connection", async () => {
    const disconnect = await engineFetch(`/mcp/${MCP_NAME}/disconnect`, { method: "POST" });
    expect(disconnect.ok).toBe(true);
    const remove = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "DELETE" });
    expect(remove.ok).toBe(true);

    const authFile = join(dataDir, "xdg-data", "opencode", "mcp-auth.json");
    const saved = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    expect(saved[MCP_NAME]).toBeUndefined();
  }, 30_000);

  test("a provider rejecting dynamic registration connects with its registered client credentials", async () => {
    const port = await getFreePort();
    const callbackPort = await getFreePort();
    const providerUrl = `http://127.0.0.1:${port}`;
    const name = "mock-registered-client";
    const mock = spawn("node", [join(repoRoot, "scripts/mock-oauth-mcp-server.mjs")], {
      env: {
        ...process.env,
        PORT: String(port), AUTO_APPROVE: "1", DYNAMIC_REGISTRATION: "0",
        CLIENT_ID: "legalwork-test-client", CLIENT_SECRET: "legalwork-test-secret",
      },
      stdio: "ignore",
    });
    let listenerId = "";
    try {
      await waitFor(async () => (await fetch(`${providerUrl}/health`)).ok ? true : null, 10_000, "registered-client mock");
      const listener = await callbacks.listen({ redirectUri: `http://127.0.0.1:${callbackPort}/mcp/oauth/callback` });
      listenerId = listener.listenerId;
      const config = { type: "remote", url: `${providerUrl}/mcp`, enabled: true, oauth: { callbackPort } };
      const add = await engineFetch("/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, config }),
      });
      expect(add.ok).toBe(true);
      const refused = await add.json();
      expect(refused[name].status).toBe("failed");
      expect(refused[name].error).toContain("Dynamic client registration is not supported");
      const rejected = await engineFetch(`/mcp/${name}/auth`, { method: "POST" });
      expect(rejected.ok).toBe(false);

      const beforeCredentials = await (await fetch(`${providerUrl}/requests`)).json();
      const registrations = beforeCredentials.requests.filter((request: { path: string }) => request.path === "/register").length;
      const configured = await engineFetch("/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          config: { ...config, oauth: { callbackPort, clientId: "legalwork-test-client", clientSecret: "legalwork-test-secret" } },
        }),
      });
      expect(configured.ok).toBe(true);
      const started = await (await engineFetch(`/mcp/${name}/auth`, { method: "POST" })).json();
      const authorizationUrl = new URL(started.authorizationUrl);
      expect(authorizationUrl.searchParams.get("client_id")).toBe("legalwork-test-client");
      const waiting = callbacks.wait({ listenerId, state: started.oauthState });
      const browser = await fetch(authorizationUrl);
      expect(browser.ok).toBe(true);
      const complete = await engineFetch(`/mcp/${name}/auth/callback`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await waiting),
      });
      expect(complete.ok).toBe(true);
      expect(await complete.json()).toEqual({ status: "connected" });
      const afterCredentials = await (await fetch(`${providerUrl}/requests`)).json();
      expect(afterCredentials.requests.filter((request: { path: string }) => request.path === "/register").length).toBe(registrations);
    } finally {
      callbacks.cancel(listenerId);
      mock.kill();
    }
  }, 30_000);

  test("manual callback is a separate explicit flow when no desktop broker is available", async () => {
    const start = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "POST" });
    const started = await start.json();
    const authorizationUrl = new URL(started.authorizationUrl);
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const location = authorize.headers.get("location");
    expect(location).toBeTruthy();
    const callbackUrl = new URL(location!);

    // auth/start alone has no engine waiter. Guard against the old UI's
    // assumption that polling would magically finish this callback.
    const unsupportedAutomaticCallback = await fetch(callbackUrl);
    expect(unsupportedAutomaticCallback.status).toBe(400);
    const beforeManual = await (await engineFetch("/mcp")).json();
    expect(beforeManual[MCP_NAME].status).not.toBe("connected");

    expect(callbackUrl.searchParams.get("state")).toBe(authorizationUrl.searchParams.get("state"));
    const complete = await engineFetch(`/mcp/${MCP_NAME}/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: callbackUrl.searchParams.get("code") }),
    });
    expect(complete.ok).toBe(true);
    expect(await complete.json()).toEqual({ status: "connected" });
  }, 30_000);
});
