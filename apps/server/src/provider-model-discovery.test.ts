import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProviderModels } from "./provider-model-discovery.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
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
  const baseURL = modelServer(() => {
    calls += 1;
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
});
