import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EIGENWELT_LOOPBACK_PORTS,
  buildEigenweltModelsMap,
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
  /** Authorization headers seen on /api/desktop/models (the firm's list). */
  desktopModelsAuth: Array<string | undefined>;
  close: () => Promise<void>;
  failModels: boolean;
};

/** The firm's own list: the admin turned "ewl-small" off on the platform. */
const FIRM_MANIFEST_PAYLOAD = {
  baseURL: MANIFEST_PAYLOAD.baseURL,
  models: [{ ...MANIFEST_PAYLOAD.models[0], region: "EU", hostedIn: "Europe", upstreamModel: "DeepSeek V4 Flash" }],
};

/** Throwaway local HTTP server standing in for the Eigenwelt platform. */
async function startFakePlatform(): Promise<FakePlatform> {
  const exchangeCalls: Array<Record<string, unknown>> = [];
  const platform: FakePlatform = {
    url: "",
    exchangeCalls,
    modelsCalls: 0,
    desktopModelsAuth: [],
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
    if (req.method === "GET" && req.url === "/api/desktop/models") {
      platform.desktopModelsAuth.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer desktop-token") {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FIRM_MANIFEST_PAYLOAD));
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

  test("the authorize URL carries the sign-in intent and a known plan, and drops anything else", async () => {
    await setupPlatform();
    const finish = async (started: { sessionId: string; authorizeUrl: string }) => {
      const url = new URL(started.authorizeUrl);
      await fetch(
        `http://127.0.0.1:${url.searchParams.get("port")}/callback?code=test-code&state=${url.searchParams.get("state")}`,
      );
      await waitForEigenweltSignIn(started.sessionId);
      return url;
    };

    const plain = await finish(await startEigenweltSignIn());
    expect(plain.searchParams.has("intent")).toBe(false);
    expect(plain.searchParams.has("plan")).toBe(false);

    const pro = await finish(await startEigenweltSignIn({ plan: "pro" }));
    expect(pro.searchParams.get("plan")).toBe("pro");
    expect(pro.searchParams.has("intent")).toBe(false);

    const returning = await finish(await startEigenweltSignIn({ intent: "sign-in", plan: "plus" }));
    expect(returning.searchParams.get("intent")).toBe("sign-in");
    expect(returning.searchParams.get("plan")).toBe("plus");

    // A value from an untyped caller never reaches the platform.
    const unknown = await finish(
      await startEigenweltSignIn({ plan: "hub" as unknown as "plus" }),
    );
    expect(unknown.searchParams.has("plan")).toBe(false);
  });

  test("waiting on an unknown session fails", async () => {
    await expect(waitForEigenweltSignIn("nope")).rejects.toThrow(/Unknown/);
  });

  test("with every port taken by unfinished sign-ins, a new sign-in replaces the oldest", async () => {
    await setupPlatform();
    const portOf = (started: { authorizeUrl: string }) =>
      Number(new URL(started.authorizeUrl).searchParams.get("port"));
    const finish = async (started: { sessionId: string; authorizeUrl: string }) => {
      const url = new URL(started.authorizeUrl);
      await fetch(
        `http://127.0.0.1:${url.searchParams.get("port")}/callback?code=test-code&state=${url.searchParams.get("state")}`,
      );
      return waitForEigenweltSignIn(started.sessionId);
    };

    // Three abandoned browser tabs hold all three ports.
    const first = await startEigenweltSignIn();
    const second = await startEigenweltSignIn();
    const third = await startEigenweltSignIn();
    expect([first, second, third].map(portOf).sort((a, b) => a - b)).toEqual([...EIGENWELT_LOOPBACK_PORTS]);

    // A fourth attempt starts anyway, on the oldest attempt's port.
    const fourth = await startEigenweltSignIn();
    expect(portOf(fourth)).toBe(portOf(first));
    await expect(waitForEigenweltSignIn(first.sessionId)).rejects.toThrow(/replaced by a newer one/);
    expect(await finish(fourth)).toEqual(EXCHANGE_PAYLOAD);

    // The attempts it did not need to replace are untouched.
    expect(await finish(second)).toEqual(EXCHANGE_PAYLOAD);
    expect(await finish(third)).toEqual(EXCHANGE_PAYLOAD);
  });

  test("ports held by another program still fail, with a message that says so", async () => {
    await setupPlatform();
    const blockers = await Promise.all(
      EIGENWELT_LOOPBACK_PORTS.map(
        (port) =>
          new Promise<Server>((resolve, reject) => {
            const blocker = createServer((_req, res) => res.end());
            blocker.once("error", reject);
            blocker.listen(port, "127.0.0.1", () => resolve(blocker));
          }),
      ),
    );
    cleanups.push(async () => {
      await Promise.all(blockers.map((blocker) => new Promise<void>((resolve) => blocker.close(() => resolve()))));
    });
    await expect(startEigenweltSignIn()).rejects.toThrow(/Another LegalWork app is signing in/);
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

  test("with the firm's access token it fetches the FIRM's list (admin on/off applied) and its facts", async () => {
    const platform = await setupPlatform();
    const manifest = await fetchEigenweltManifest({ platformToken: "desktop-token" });
    expect(platform.desktopModelsAuth).toEqual(["Bearer desktop-token"]);
    expect(platform.modelsCalls).toBe(0); // never the public catalog
    expect(manifest.models).toEqual([
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextLength: 200000,
        region: "EU",
        hostedIn: "Europe",
        upstreamModel: "DeepSeek V4 Flash",
      },
    ]);
  });

  test("a rejected token says to sign in again instead of falling back to the public catalog", async () => {
    const platform = await setupPlatform();
    await expect(fetchEigenweltManifest({ platformToken: "stale-token" })).rejects.toThrow(
      /sign in again/i,
    );
    expect(platform.modelsCalls).toBe(0);
  });

  test("an empty token means the public catalog (paste-a-key path)", async () => {
    const platform = await setupPlatform();
    const manifest = await fetchEigenweltManifest({ platformToken: null });
    expect(platform.modelsCalls).toBe(1);
    expect(manifest.models).toHaveLength(2);
  });
});

describe("buildEigenweltModelsMap", () => {
  test("lets images and PDFs through only to the models that read them", () => {
    const models = buildEigenweltModelsMap([
      { id: "gemini", inputModalities: ["text", "image", "pdf"] },
      { id: "glm", inputModalities: ["text", "image"] },
      { id: "deepseek", inputModalities: ["text"] },
      { id: "older-platform" },
    ]) as Record<string, Record<string, unknown>>;

    expect(models.gemini).toMatchObject({
      attachment: true,
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models.glm).toMatchObject({ attachment: true, modalities: { input: ["text", "image"], output: ["text"] } });
    expect(models.deepseek).toMatchObject({ attachment: false, modalities: { input: ["text"], output: ["text"] } });
    // No list from the platform: the engine's own default (text only) stays.
    expect(models["older-platform"]).not.toHaveProperty("modalities");
    expect(models["older-platform"]).not.toHaveProperty("attachment");
  });

  test("never writes a modality the engine schema does not know", () => {
    const models = buildEigenweltModelsMap([
      { id: "odd", inputModalities: ["video", "image"] as never },
    ]) as Record<string, Record<string, unknown>>;
    expect(models.odd.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
  });
});

describe("refreshEigenweltProviderModels", () => {
  const staleProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: "Eigenwelt Subscription",
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
    // Both limit keys are mandatory for the engine schema. Neither manifest
    // model reports an output limit, so both get the 32k default — which is
    // also how a config written with the old hardcoded 16,384 gets replaced.
    expect(models["deepseek-v4-flash"]?.limit).toEqual({ context: 200000, output: 32000 });
    expect(models["ewl-small"]?.limit).toEqual({ context: 128000, output: 32000 });

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
