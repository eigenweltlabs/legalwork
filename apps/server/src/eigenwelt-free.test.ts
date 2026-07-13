import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EIGENWELT_ANALYTICS_ID_HEADER, launchAnalyticsId } from "./launch-analytics-id.js";
import {
  buildEigenweltFreeProviderBlock,
  eigenweltFreeDeviceId,
  eigenweltFreeManifestCachePath,
  fetchEigenweltFreeModels,
  mintEigenweltFreeDeviceKey,
  readCachedEigenweltFreeManifest,
  refreshEigenweltFreeManifest,
  resetEigenweltFreeManifestRefreshThrottleForTests,
} from "./eigenwelt-free.js";
import type { ServerConfig } from "./types.js";

const FREE_MODELS = [
  { id: "ewl-free-small", name: "EWL Free Small", description: "Fast free model", contextLength: 32000 },
  { id: "ewl-free-base" },
];

/** What POST /api/public/free-key returns: this device's own key. */
const FREE_KEY_PAYLOAD = {
  apiKey: "sk-device-key-1",
  baseURL: "https://free.gateway.test/v1",
  models: FREE_MODELS,
};

/** What GET /api/public/free-models returns: NO key, just the catalog. */
const FREE_MODELS_PAYLOAD = {
  baseURL: "https://free.gateway.test/v1",
  models: FREE_MODELS,
};

/** A cached manifest as written after a successful mint. */
const CACHED_MANIFEST = {
  baseURL: "https://free.gateway.test/v1",
  apiKey: "sk-device-key-cached",
  models: FREE_MODELS,
};

type FakePlatform = {
  url: string;
  freeModelsCalls: number;
  freeKeyCalls: number;
  lastFreeKeyDeviceId: string | undefined;
  lastFreeKeyMintHeader: string | undefined;
  close: () => Promise<void>;
  failFreeModels: boolean;
  failFreeKey: boolean;
  modelsPayload: Record<string, unknown>;
  keyPayload: Record<string, unknown>;
};

/** Throwaway local HTTP server standing in for the Eigenwelt platform's
 * public free-tier endpoints (free-models + free-key). */
async function startFakePlatform(): Promise<FakePlatform> {
  const platform: FakePlatform = {
    url: "",
    freeModelsCalls: 0,
    freeKeyCalls: 0,
    lastFreeKeyDeviceId: undefined,
    lastFreeKeyMintHeader: undefined,
    close: async () => {},
    failFreeModels: false,
    failFreeKey: false,
    modelsPayload: { ...FREE_MODELS_PAYLOAD },
    keyPayload: { ...FREE_KEY_PAYLOAD },
  };

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/public/free-models") {
      platform.freeModelsCalls += 1;
      if (platform.failFreeModels) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gateway unreachable" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(platform.modelsPayload));
      return;
    }
    if (req.method === "POST" && req.url === "/api/public/free-key") {
      platform.freeKeyCalls += 1;
      platform.lastFreeKeyMintHeader = Array.isArray(req.headers["x-eigenwelt-mint-key"])
        ? req.headers["x-eigenwelt-mint-key"][0]
        : req.headers["x-eigenwelt-mint-key"];
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        try {
          platform.lastFreeKeyDeviceId = (JSON.parse(body) as { deviceId?: string }).deviceId;
        } catch {
          platform.lastFreeKeyDeviceId = undefined;
        }
        if (platform.failFreeKey) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(platform.keyPayload));
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake platform failed to bind");
  platform.url = `http://127.0.0.1:${address.port}`;
  platform.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return platform;
}

const previousPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const previousRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
const previousMintKey = process.env.EIGENWELT_FREE_MINT_KEY;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  resetEigenweltFreeManifestRefreshThrottleForTests();
  if (previousPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = previousPlatformUrl;
  if (previousRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousRuntimeDb;
  if (previousMintKey === undefined) delete process.env.EIGENWELT_FREE_MINT_KEY;
  else process.env.EIGENWELT_FREE_MINT_KEY = previousMintKey;
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

async function setupRuntimeDb(): Promise<{ root: string; config: ServerConfig }> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-free-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return { root, config: serverConfig(root) };
}

describe("mintEigenweltFreeDeviceKey", () => {
  test("POSTs the device id and returns the per-device key manifest", async () => {
    const platform = await setupPlatform();
    const manifest = await mintEigenweltFreeDeviceKey("device-under-test-1234");
    expect(platform.freeKeyCalls).toBe(1);
    expect(platform.lastFreeKeyDeviceId).toBe("device-under-test-1234");
    expect(manifest.apiKey).toBe(FREE_KEY_PAYLOAD.apiKey);
    expect(manifest.baseURL).toBe(FREE_KEY_PAYLOAD.baseURL);
    expect(manifest.models.map((model) => model.id)).toEqual(["ewl-free-small", "ewl-free-base"]);
  });

  test("sends the baked-in mint token header (env override)", async () => {
    const platform = await setupPlatform();
    process.env.EIGENWELT_FREE_MINT_KEY = "mint-token-under-test";
    await mintEigenweltFreeDeviceKey("device-under-test-1234");
    expect(platform.lastFreeKeyMintHeader).toBe("mint-token-under-test");
  });

  test("omits the mint token header when no token is configured", async () => {
    const platform = await setupPlatform();
    delete process.env.EIGENWELT_FREE_MINT_KEY;
    await mintEigenweltFreeDeviceKey("device-under-test-1234");
    expect(platform.lastFreeKeyMintHeader).toBeUndefined();
  });

  test("rejects when the platform is unreachable", async () => {
    const platform = await setupPlatform();
    await platform.close();
    await expect(mintEigenweltFreeDeviceKey("device-under-test-1234")).rejects.toThrow(
      /Could not reach the Eigenwelt platform/,
    );
  });

  test("rejects when the platform refuses the mint (429)", async () => {
    const platform = await setupPlatform();
    platform.failFreeKey = true;
    await expect(mintEigenweltFreeDeviceKey("device-under-test-1234")).rejects.toThrow(
      /did not issue a free key \(HTTP 429\)/,
    );
  });

  test("rejects an incomplete payload (missing apiKey)", async () => {
    const platform = await setupPlatform();
    platform.keyPayload = { baseURL: "https://free.gateway.test/v1", models: [] };
    await expect(mintEigenweltFreeDeviceKey("device-under-test-1234")).rejects.toThrow(
      /invalid free-key payload/,
    );
  });
});

describe("fetchEigenweltFreeModels", () => {
  test("fetches baseURL and models (no key in this endpoint)", async () => {
    await setupPlatform();
    const manifest = await fetchEigenweltFreeModels();
    expect(manifest.baseURL).toBe(FREE_MODELS_PAYLOAD.baseURL);
    expect(manifest.models.map((model) => model.id)).toEqual(["ewl-free-small", "ewl-free-base"]);
  });

  test("rejects when the platform is unreachable", async () => {
    const platform = await setupPlatform();
    await platform.close();
    await expect(fetchEigenweltFreeModels()).rejects.toThrow(/Could not reach the Eigenwelt platform/);
  });

  test("rejects an invalid payload (missing baseURL)", async () => {
    const platform = await setupPlatform();
    platform.modelsPayload = { models: [] };
    await expect(fetchEigenweltFreeModels()).rejects.toThrow(/invalid free-models manifest/);
  });
});

describe("refreshEigenweltFreeManifest", () => {
  test("first run mints the device key (free-key, not free-models) and caches it", async () => {
    const platform = await setupPlatform();
    const { root, config } = await setupRuntimeDb();

    const changed = await refreshEigenweltFreeManifest(config);
    expect(changed).toBe(true);
    expect(platform.freeKeyCalls).toBe(1);
    expect(platform.freeModelsCalls).toBe(0);

    // The mint carried the persisted install device id.
    const deviceId = (await readFile(join(root, "eigenwelt-free-device-id"), "utf8")).trim();
    expect(platform.lastFreeKeyDeviceId).toBe(deviceId);

    const cached = await readCachedEigenweltFreeManifest(config);
    expect(cached?.apiKey).toBe(FREE_KEY_PAYLOAD.apiKey);
    expect(cached?.baseURL).toBe(FREE_KEY_PAYLOAD.baseURL);
    expect(cached?.models.map((model) => model.id)).toEqual(["ewl-free-small", "ewl-free-base"]);

    // A second call within the throttle window does nothing (no fetch).
    const again = await refreshEigenweltFreeManifest(config);
    expect(again).toBe(false);
    expect(platform.freeKeyCalls).toBe(1);
    expect(platform.freeModelsCalls).toBe(0);
  });

  test("NEVER re-mints while a key is cached — refresh only updates models, key preserved", async () => {
    const platform = await setupPlatform();
    platform.modelsPayload = {
      baseURL: "https://free.gateway.test/v2",
      models: [{ id: "ewl-free-next", contextLength: 64000 }],
    };
    const { config } = await setupRuntimeDb();
    await writeFile(eigenweltFreeManifestCachePath(config), JSON.stringify(CACHED_MANIFEST), "utf8");

    const changed = await refreshEigenweltFreeManifest(config);
    expect(changed).toBe(true);
    // The mint endpoint must not be touched: re-minting rotates (and thereby
    // invalidates) this device's key on the platform side.
    expect(platform.freeKeyCalls).toBe(0);
    expect(platform.freeModelsCalls).toBe(1);

    const cached = await readCachedEigenweltFreeManifest(config);
    expect(cached?.apiKey).toBe(CACHED_MANIFEST.apiKey); // key preserved
    expect(cached?.baseURL).toBe("https://free.gateway.test/v2"); // baseURL refreshed
    expect(cached?.models.map((model) => model.id)).toEqual(["ewl-free-next"]); // models refreshed
  });

  test("unchanged free-models payload does not rewrite the cache", async () => {
    const platform = await setupPlatform();
    const { config } = await setupRuntimeDb();
    await writeFile(eigenweltFreeManifestCachePath(config), JSON.stringify(CACHED_MANIFEST), "utf8");

    // The fake platform serves exactly the cached baseURL/models.
    platform.modelsPayload = { baseURL: CACHED_MANIFEST.baseURL, models: CACHED_MANIFEST.models };
    const changed = await refreshEigenweltFreeManifest(config);
    expect(changed).toBe(false);
    expect(platform.freeKeyCalls).toBe(0);
    expect(platform.freeModelsCalls).toBe(1);
    expect((await readCachedEigenweltFreeManifest(config))?.apiKey).toBe(CACHED_MANIFEST.apiKey);
  });

  test("free-models failure keeps the cached manifest (offline fallback)", async () => {
    const platform = await setupPlatform();
    platform.failFreeModels = true;
    const { config } = await setupRuntimeDb();
    await writeFile(eigenweltFreeManifestCachePath(config), JSON.stringify(CACHED_MANIFEST), "utf8");

    const changed = await refreshEigenweltFreeManifest(config);
    expect(changed).toBe(false);
    expect(platform.freeModelsCalls).toBe(1);
    expect(platform.freeKeyCalls).toBe(0); // failure must NOT trigger a mint

    // The last good manifest (incl. the key) still backs the free provider.
    const cached = await readCachedEigenweltFreeManifest(config);
    expect(cached?.apiKey).toBe(CACHED_MANIFEST.apiKey);
    expect(cached?.models.map((model) => model.id)).toEqual(["ewl-free-small", "ewl-free-base"]);
  });

  test("mint failure leaves no cache; the next refresh retries the mint", async () => {
    const platform = await setupPlatform();
    platform.failFreeKey = true;
    const { config } = await setupRuntimeDb();

    expect(await refreshEigenweltFreeManifest(config)).toBe(false);
    expect(platform.freeKeyCalls).toBe(1);
    expect(await readCachedEigenweltFreeManifest(config)).toBeNull();

    // Recovery: platform mints on the next (unthrottled) attempt.
    platform.failFreeKey = false;
    resetEigenweltFreeManifestRefreshThrottleForTests();
    expect(await refreshEigenweltFreeManifest(config)).toBe(true);
    expect(platform.freeKeyCalls).toBe(2);
    expect((await readCachedEigenweltFreeManifest(config))?.apiKey).toBe(FREE_KEY_PAYLOAD.apiKey);
  });

  test("corrupt cache counts as no key: refresh mints", async () => {
    const platform = await setupPlatform();
    const { config } = await setupRuntimeDb();
    await writeFile(eigenweltFreeManifestCachePath(config), "not json {", "utf8");
    expect(await readCachedEigenweltFreeManifest(config)).toBeNull();

    const changed = await refreshEigenweltFreeManifest(config);
    expect(changed).toBe(true);
    expect(platform.freeKeyCalls).toBe(1);
    expect((await readCachedEigenweltFreeManifest(config))?.apiKey).toBe(FREE_KEY_PAYLOAD.apiKey);
  });
});

describe("readCachedEigenweltFreeManifest", () => {
  test("missing cache file yields null", async () => {
    const { config } = await setupRuntimeDb();
    expect(await readCachedEigenweltFreeManifest(config)).toBeNull();
  });

  test("structurally invalid cache (no apiKey) is ignored", async () => {
    const { config } = await setupRuntimeDb();
    await writeFile(
      eigenweltFreeManifestCachePath(config),
      JSON.stringify({ baseURL: "https://x.test", models: [] }),
      "utf8",
    );
    expect(await readCachedEigenweltFreeManifest(config)).toBeNull();
  });
});

describe("eigenweltFreeDeviceId", () => {
  test("mints once, persists to disk, and stays stable", async () => {
    const { root, config } = await setupRuntimeDb();
    const first = await eigenweltFreeDeviceId(config);
    expect(first.length).toBeGreaterThan(0);
    expect((await readFile(join(root, "eigenwelt-free-device-id"), "utf8")).trim()).toBe(first);
    expect(await eigenweltFreeDeviceId(config)).toBe(first);
  });
});

describe("buildEigenweltFreeProviderBlock", () => {
  test("carries the per-device key, the launch analytics id, and both limit keys", () => {
    const block = buildEigenweltFreeProviderBlock({ ...CACHED_MANIFEST }) as {
      npm: string;
      name: string;
      options: { baseURL: string; apiKey: string; headers?: Record<string, string> };
      models: Record<string, { limit: { context: number; output: number } }>;
    };
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
    expect(block.name).toBe("Eigenwelt Free");
    expect(block.options.baseURL).toBe(CACHED_MANIFEST.baseURL);
    // The device's own key travels as an Authorization header — the engine
    // spreads options into createOpenAICompatible, which ignores `apiKey`.
    expect(block.options.headers).toEqual({
      Authorization: `Bearer ${CACHED_MANIFEST.apiKey}`,
      // Anonymous per-launch id — never the persistent device id.
      [EIGENWELT_ANALYTICS_ID_HEADER]: launchAnalyticsId(),
    });
    expect(block.options.apiKey).toBeUndefined();
    // Both limit keys are mandatory for the engine schema.
    expect(block.models["ewl-free-small"]?.limit).toEqual({ context: 32000, output: 16384 });
    expect(block.models["ewl-free-base"]?.limit).toEqual({ context: 128000, output: 16384 });
    // The manifest's description field must not leak into the engine config.
    expect("description" in (block.models["ewl-free-small"] as Record<string, unknown>)).toBe(false);
  });

  test("launch analytics id is stable within a process and is a UUID", () => {
    expect(launchAnalyticsId()).toBe(launchAnalyticsId());
    expect(launchAnalyticsId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
