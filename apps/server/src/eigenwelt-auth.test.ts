import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EIGENWELT_LOOPBACK_PORTS,
  fetchEigenweltManifest,
  refreshEigenweltProviderModels,
  startEigenweltSignIn,
  waitForEigenweltSignIn,
} from "./eigenwelt-auth.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const EXCHANGE_PAYLOAD = {
  apiKey: "ewl_test_key",
  baseURL: "https://gateway.test/v1",
  orgId: "org_1",
  orgName: "Test Firm",
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 200000 },
    { id: "ewl-small", name: "EWL Small" },
  ],
};

const MANIFEST_PAYLOAD = {
  baseURL: "https://gateway.test/v1",
  models: EXCHANGE_PAYLOAD.models,
};

type FakePlatform = {
  url: string;
  exchangeCalls: Array<Record<string, unknown>>;
  modelsCalls: number;
  close: () => Promise<void>;
  failModels: boolean;
};

/** Throwaway local HTTP server standing in for the Eigenwelt platform. */
async function startFakePlatform(): Promise<FakePlatform> {
  const exchangeCalls: Array<Record<string, unknown>> = [];
  const platform: FakePlatform = {
    url: "",
    exchangeCalls,
    modelsCalls: 0,
    close: async () => {},
    failModels: false,
  };

  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/desktop/exchange") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        exchangeCalls.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(EXCHANGE_PAYLOAD));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/public/models") {
      platform.modelsCalls += 1;
      if (platform.failModels) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gateway unreachable" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MANIFEST_PAYLOAD));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake platform failed to bind");
  platform.url = `http://127.0.0.1:${address.port}`;
  // Idempotent: tests close mid-test and the afterEach cleanup closes again.
  platform.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return platform;
}

const previousPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const previousRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = previousPlatformUrl;
  if (previousRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousRuntimeDb;
});

async function setupPlatform(): Promise<FakePlatform> {
  const platform = await startFakePlatform();
  cleanups.push(() => platform.close());
  process.env.EIGENWELT_PLATFORM_URL = platform.url;
  return platform;
}

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function setupRuntimeDb(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-auth-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return serverConfig(root);
}

describe("eigenwelt sign-in", () => {
  test("full flow: start -> browser callback -> wait resolves with the exchange payload", async () => {
    const platform = await setupPlatform();

    const { sessionId, authorizeUrl } = await startEigenweltSignIn();
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe(platform.url);
    expect(url.pathname).toBe("/desktop/connect");
    const state = url.searchParams.get("state");
    const port = Number(url.searchParams.get("port"));
    expect(state?.length).toBeGreaterThanOrEqual(24);
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThanOrEqual(40);
    expect(EIGENWELT_LOOPBACK_PORTS.includes(port as (typeof EIGENWELT_LOOPBACK_PORTS)[number])).toBe(true);

    // Wrong state must be rejected by the loopback.
    const bad = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=wrong`);
    expect(bad.status).toBe(400);

    // Simulate the browser redirect with the correct state.
    const ok = await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("You're connected");

    const result = await waitForEigenweltSignIn(sessionId);
    expect(result).toEqual(EXCHANGE_PAYLOAD);

    // The platform received the PKCE exchange with our state and port.
    expect(platform.exchangeCalls).toHaveLength(1);
    expect(platform.exchangeCalls[0]?.state).toBe(state);
    expect(platform.exchangeCalls[0]?.port).toBe(port);
    expect(typeof platform.exchangeCalls[0]?.verifier).toBe("string");
    expect(platform.exchangeCalls[0]?.code).toBe("test-code");

    // Sessions are single-consume: a second wait fails.
    await expect(waitForEigenweltSignIn(sessionId)).rejects.toThrow(/Unknown or already-completed/);

    // The loopback port was released.
    const released = await fetch(`http://127.0.0.1:${port}/callback`).then(
      () => false,
      () => true,
    );
    expect(released).toBe(true);
  });

  test("wait returns {pending:true} while the browser flow is incomplete", async () => {
    await setupPlatform();
    const { sessionId, authorizeUrl } = await startEigenweltSignIn();
    const result = await waitForEigenweltSignIn(sessionId, 50);
    expect(result).toEqual({ pending: true });

    // Finish the flow so the loopback is torn down.
    const url = new URL(authorizeUrl);
    const port = Number(url.searchParams.get("port"));
    const state = url.searchParams.get("state");
    await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
    await waitForEigenweltSignIn(sessionId);
  });

  test("failed exchange rejects the wait with a clear message and frees the port", async () => {
    const platform = await setupPlatform();
    await platform.close();

    const { sessionId, authorizeUrl } = await startEigenweltSignIn();
    const url = new URL(authorizeUrl);
    const port = Number(url.searchParams.get("port"));
    const state = url.searchParams.get("state");
    await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);

    await expect(waitForEigenweltSignIn(sessionId)).rejects.toThrow(/could not reach the Eigenwelt platform/);

    // Cleanup didn't leak the port: starting again binds the same first port.
    process.env.EIGENWELT_PLATFORM_URL = (await setupPlatform()).url;
    const restarted = await startEigenweltSignIn();
    const restartedUrl = new URL(restarted.authorizeUrl);
    expect(Number(restartedUrl.searchParams.get("port"))).toBe(port);
    const restartedState = restartedUrl.searchParams.get("state");
    await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${restartedState}`);
    await waitForEigenweltSignIn(restarted.sessionId);
  });

  test("waiting on an unknown session fails", async () => {
    await expect(waitForEigenweltSignIn("nope")).rejects.toThrow(/Unknown/);
  });
});

describe("eigenwelt manifest", () => {
  test("fetches baseURL and models from the platform", async () => {
    await setupPlatform();
    const manifest = await fetchEigenweltManifest();
    expect(manifest.baseURL).toBe(MANIFEST_PAYLOAD.baseURL);
    expect(manifest.models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "ewl-small"]);
  });

  test("surfaces a clear error when the platform is unreachable", async () => {
    const platform = await setupPlatform();
    await platform.close();
    await expect(fetchEigenweltManifest()).rejects.toThrow(/Could not reach the Eigenwelt platform/);
  });
});

describe("refreshEigenweltProviderModels", () => {
  const staleProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: "Eigenwelt Model API",
    options: { baseURL: "https://gateway.test/v1" },
    models: {
      "stale-model": {
        name: "Stale Model",
        tool_call: true,
        reasoning: false,
        limit: { context: 128000, output: 16384 },
      },
    },
  };

  test("replaces stale models from the manifest, throttles repeats, keeps config on fetch failure", async () => {
    const platform = await setupPlatform();
    const config = await setupRuntimeDb();

    await writeRuntimeOpencodeConfig(config, "ws_refresh_1", (current) => ({
      ...current,
      provider: { eigenwelt: staleProvider },
    }));

    const refreshed = await refreshEigenweltProviderModels(config, "ws_refresh_1");
    expect(refreshed).toBe(true);

    const runtime = await readRuntimeOpencodeConfig(config, "ws_refresh_1");
    const eigenwelt = (runtime.provider as Record<string, Record<string, unknown>>).eigenwelt;
    // baseURL/name/npm preserved as stored; models replaced from the manifest.
    expect(eigenwelt.npm).toBe("@ai-sdk/openai-compatible");
    expect((eigenwelt.options as Record<string, unknown>).baseURL).toBe("https://gateway.test/v1");
    const models = eigenwelt.models as Record<string, { limit?: { context?: number; output?: number } }>;
    expect(Object.keys(models).sort()).toEqual(["deepseek-v4-flash", "ewl-small"]);
    expect(models["stale-model"]).toBeUndefined();
    // Both limit keys are mandatory for the engine schema.
    expect(models["deepseek-v4-flash"]?.limit).toEqual({ context: 200000, output: 16384 });
    expect(models["ewl-small"]?.limit).toEqual({ context: 128000, output: 16384 });

    // Second call within the throttle window does nothing (no write, no fetch).
    const modelsCallsAfterFirst = platform.modelsCalls;
    const again = await refreshEigenweltProviderModels(config, "ws_refresh_1");
    expect(again).toBe(false);
    expect(platform.modelsCalls).toBe(modelsCallsAfterFirst);
  });

  test("manifest fetch failure leaves the stored config untouched", async () => {
    const platform = await setupPlatform();
    platform.failModels = true;
    const config = await setupRuntimeDb();

    await writeRuntimeOpencodeConfig(config, "ws_refresh_2", (current) => ({
      ...current,
      provider: { eigenwelt: staleProvider },
    }));

    const refreshed = await refreshEigenweltProviderModels(config, "ws_refresh_2");
    expect(refreshed).toBe(false);

    const runtime = await readRuntimeOpencodeConfig(config, "ws_refresh_2");
    const eigenwelt = (runtime.provider as Record<string, Record<string, unknown>>).eigenwelt;
    expect(Object.keys(eigenwelt.models as Record<string, unknown>)).toEqual(["stale-model"]);
  });

  test("no-op for workspaces without an eigenwelt provider block", async () => {
    await setupPlatform();
    const config = await setupRuntimeDb();
    const refreshed = await refreshEigenweltProviderModels(config, "ws_refresh_3");
    expect(refreshed).toBe(false);
  });
});
