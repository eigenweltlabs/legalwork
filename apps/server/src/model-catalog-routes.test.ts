import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import { modelCatalogFor, startModelCatalogRelay } from "./model-catalog.js";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";

test("authenticated Privacy changes gate the running engine relay and survive a new server instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-catalog-routes-"));
  const previousStore = process.env.LEGALWORK_TOKEN_STORE;
  const previousUrl = process.env.OPENCODE_MODELS_URL;
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  let requests = 0;
  const registry = { provider: { models: { model: { name: "Model", limit: { context: 128000, output: 32000 } } } } };
  const mirror = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json(registry); } });
  process.env.OPENCODE_MODELS_URL = `http://127.0.0.1:${mirror.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "catalog-client-token", hostToken: "catalog-host-token",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, configPath: join(root, "server.json"),
  };
  const server = await startServer(config);
  const relay = await startModelCatalogRelay(config);
  try {
    const baseURL = `http://127.0.0.1:${server.port}`;
    const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
    expect((await fetch(`${baseURL}/model-catalog/settings`)).status).toBe(401);
    expect(await (await fetch(`${baseURL}/model-catalog/settings`, { headers })).json()).toEqual({ onlineUpdatesEnabled: true });
    const viewer = await new TokenService(config).create("viewer");
    expect((await fetch(`${baseURL}/model-catalog/settings`, {
      method: "PUT", headers: { ...headers, Authorization: `Bearer ${viewer.token}` }, body: JSON.stringify({ onlineUpdatesEnabled: false }),
    })).status).toBe(403);
    expect((await fetch(`${baseURL}/model-catalog/settings`, { method: "PUT", headers, body: JSON.stringify({ onlineUpdatesEnabled: "false" }) })).status).toBe(400);
    expect(await (await fetch(`${relay.url}/api.json`)).json()).toEqual(registry);
    expect(requests).toBe(1);
    const saved = await fetch(`${baseURL}/model-catalog/settings`, { method: "PUT", headers, body: JSON.stringify({ onlineUpdatesEnabled: false }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ onlineUpdatesEnabled: false });
    expect(await (await fetch(`${relay.url}/api.json`)).json()).toEqual(registry);
    expect(await (await fetch(`${baseURL}/model-catalog/api.json`)).json()).toEqual(registry);
    await expect(modelCatalogFor(config).providerModels("provider")).rejects.toThrow("disabled");
    const restarted = modelCatalogFor({ ...config });
    expect(await restarted.settings()).toEqual({ onlineUpdatesEnabled: false });
    expect(await restarted.get()).toEqual(registry);
    expect(requests).toBe(1);
  } finally {
    await relay.stop();
    await server.stop();
    mirror.stop(true);
    if (previousStore === undefined) delete process.env.LEGALWORK_TOKEN_STORE;
    else process.env.LEGALWORK_TOKEN_STORE = previousStore;
    if (previousUrl === undefined) delete process.env.OPENCODE_MODELS_URL;
    else process.env.OPENCODE_MODELS_URL = previousUrl;
    await rm(root, { recursive: true, force: true });
  }
});
