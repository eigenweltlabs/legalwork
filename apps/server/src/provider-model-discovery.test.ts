import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProviderModels } from "./provider-model-discovery.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

test("built-in worker refresh uses the catalog and only persists new models", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-catalog-route-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const details = { name: "New built-in model", reasoning: true, tool_call: true, limit: { context: 200000, output: 64000 } };
  const catalogURL = modelServer(request => {
    expect(request.headers.get("authorization")).toBeNull();
    expect(new URL(request.url).pathname).toBe("/v1/api.json");
    return Response.json({ anthropic: { models: { old: details, new: details } } });
  });
  const originalURL = process.env.OPENCODE_MODELS_URL;
  process.env.OPENCODE_MODELS_URL = catalogURL;
  cleanup.push(() => { if (originalURL === undefined) delete process.env.OPENCODE_MODELS_URL; else process.env.OPENCODE_MODELS_URL = originalURL; });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/provider") return Response.json({ all: [{ id: "anthropic", models: { old: details } }], connected: ["anthropic"], default: {} });
    if (path === "/session/status") return Response.json({ running: { type: "busy" } });
    return Response.json({});
  } });
  cleanup.push(() => { engine.stop(true); });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "catalog-test", hostToken: "catalog-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "ws_catalog", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    opencodeBaseUrl: `http://127.0.0.1:${engine.port}`, authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  cleanup.push(() => server.stop());
  const endpoint = `http://127.0.0.1:${server.port}/workspace/ws_catalog/provider-model-refresh`;
  expect((await fetch(endpoint, { method: "POST", body: "{}" })).status).toBe(401);
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ providerId: "anthropic", force: true, catalog: true }) });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.reloaded).toBe(false);
  expect(result.providers.anthropic.pendingReload).toBe(true);
  expect((await readRuntimeOpencodeConfig(config, "ws_catalog")).provider?.anthropic).toEqual({ models: { new: details } });
});

function modelServer(handler: (request: Request) => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanup.push(() => { server.stop(true); });
  return `http://127.0.0.1:${server.port}/v1`;
}

test("reads exact served IDs on each request, including removals and empty inventory", async () => {
  let models = ["local/qwen", "local/llama", "local/qwen"];
  const baseURL = modelServer((request) => {
    expect(new URL(request.url).pathname).toBe("/v1/models");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    return Response.json({ data: [...models.map((id) => ({ id })), { id: 42 }, {}] });
  });
  expect(await discoverProviderModels(`${baseURL}/`, "test-key")).toEqual(["local/llama", "local/qwen"]);
  models = ["local/new"];
  expect(await discoverProviderModels(baseURL, "test-key")).toEqual(["local/new"]);
  models = [];
  expect(await discoverProviderModels(baseURL, "test-key")).toEqual([]);
});

test("rejects HTTP errors, malformed inventories, and redirects without catalog fallback", async () => {
  for (const response of [
    new Response("Unauthorized", { status: 401 }),
    new Response("not JSON"),
    Response.json({ models: ["invented"] }),
    new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1/secret" } }),
  ]) {
    const baseURL = modelServer(() => response.clone());
    await expect(discoverProviderModels(baseURL, "")).rejects.toThrow();
  }
  for (const baseURL of ["", "file:///tmp/models", "http://user:secret@localhost/v1", "http://localhost/v1?x=1"]) {
    await expect(discoverProviderModels(baseURL, "")).rejects.toThrow("Enter an HTTP or HTTPS base URL");
  }
});

test("worker route requires authorization and returns the endpoint's inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-model-discovery-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let lastAuthorization = "";
  const baseURL = modelServer((request) => {
    calls += 1;
    lastAuthorization = request.headers.get("authorization") ?? "";
    return Response.json({ data: [{ id: "customer/model-7" }] });
  });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0,
    token: "owt_discovery_test", hostToken: "owt_discovery_host",
    configPath: join(root, "server.json"),
    approval: { mode: "manual", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  cleanup.push(() => server.stop());
  const endpoint = `http://127.0.0.1:${server.port}/workspace/ws_1/provider-models`;
  const request = (token?: string) => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ baseURL, apiKey: "" }),
  });
  expect((await request()).status).toBe(401);
  expect(calls).toBe(0);
  const response = await request(config.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ models: ["customer/model-7"] });
  expect(calls).toBe(1);
  await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ provider: { custom: {
    npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: "saved-test-key" }, models: { old: { name: "Old model" } },
  } } }));
  const savedKeyDiscovery = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ providerId: "custom", baseURL, apiKey: "" }),
  });
  expect(savedKeyDiscovery.status).toBe(200);
  expect(lastAuthorization).toBe("Bearer saved-test-key");
  const otherURL = modelServer((request) => {
    expect(request.headers.get("authorization")).toBeNull();
    return Response.json({ data: [{ id: "other/model" }] });
  });
  const changedEndpoint = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ providerId: "custom", baseURL: otherURL, apiKey: "" }),
  });
  expect(changedEndpoint.status).toBe(200);
  expect(await changedEndpoint.json()).toEqual({ models: ["other/model"] });
  const refreshEndpoint = endpoint.replace("provider-models", "provider-model-refresh");
  expect((await fetch(refreshEndpoint, { method: "POST", body: "{}" })).status).toBe(401);
  const refresh = await fetch(refreshEndpoint, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ providerId: "custom", force: true }),
  });
  expect(refresh.status).toBe(200);
  const result = await refresh.json();
  expect(result.reloaded).toBe(false);
  expect(result.providers.custom.pendingReload).toBe(false);
  expect(result.providers.custom.availableModels).toEqual(["customer/model-7"]);
  expect((await readRuntimeOpencodeConfig(config, "ws_1")).provider?.custom).toMatchObject({ models: { old: { name: "Old model" } } });
  expect((await readRuntimeOpencodeConfig(config, "ws_1")).provider?.custom).not.toHaveProperty("models.customer/model-7");
  expect(JSON.stringify(result)).not.toContain("saved-test-key");
});
