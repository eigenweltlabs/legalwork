import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, modelCatalogFor, modelCatalogResponse, startModelCatalogRelay } from "./model-catalog.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const originalUrl = process.env.OPENCODE_MODELS_URL;
const registry = { anthropic: { models: { model: { name: "Model", reasoning: true, limit: { context: 128000, output: 32000 } } } } };
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-model-catalog-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalUrl === undefined) delete process.env.OPENCODE_MODELS_URL;
  else process.env.OPENCODE_MODELS_URL = originalUrl;
});

test("defaults to online updates, fetches Eigenwelt without credentials, and shares cached requests", async () => {
  delete process.env.OPENCODE_MODELS_URL;
  let requests = 0;
  const root = await directory();
  const catalog = new ModelCatalog(root, async (url, options) => {
    requests++;
    expect(url).toBe("https://platform.eigenweltlabs.com/api/public/model-catalog/api.json");
    expect(options.redirect).toBe("error");
    expect(options.headers).toBeUndefined();
    return Response.json(registry);
  });
  expect(await catalog.settings()).toEqual({ onlineUpdatesEnabled: true });
  expect(await Promise.all([catalog.get(), catalog.get(), catalog.get()])).toEqual([registry, registry, registry]);
  expect(requests).toBe(1);
  expect(await catalog.get()).toEqual(registry);
  expect(requests).toBe(1);
  expect(JSON.parse(await readFile(join(root, "model-catalog.json"), "utf8"))).toMatchObject({ catalog: registry });
});

test("opt-out stops automatic and manual updates immediately and persists across restart", async () => {
  let requests = 0;
  const root = await directory();
  const fetchCatalog = async () => { requests++; return Response.json(registry); };
  const catalog = new ModelCatalog(root, fetchCatalog);
  await catalog.get();
  await catalog.saveSettings({ onlineUpdatesEnabled: false });
  expect(await catalog.get(true)).toEqual(registry);
  await expect(catalog.providerModels("anthropic")).rejects.toThrow("disabled");
  const restarted = new ModelCatalog(root, fetchCatalog);
  expect(await restarted.settings()).toEqual({ onlineUpdatesEnabled: false });
  expect(await restarted.get()).toEqual(registry);
  expect(requests).toBe(1);
  await restarted.saveSettings({ onlineUpdatesEnabled: true });
  expect(await restarted.providerModels("anthropic")).toEqual(registry.anthropic.models);
  expect(requests).toBe(2);
});

test("opt-out on a fresh device never requests online data and returns no empty registry", async () => {
  const root = await directory();
  await writeFile(join(root, "model-catalog-settings.json"), JSON.stringify({ onlineUpdatesEnabled: false }));
  let requests = 0;
  const catalog = new ModelCatalog(root, async () => { requests++; return Response.json(registry); });
  expect((await modelCatalogResponse(catalog)).status).toBe(503);
  expect(await catalog.engineCatalogPath()).toBeUndefined();
  await expect(catalog.providerModels("anthropic")).rejects.toThrow("disabled");
  expect(requests).toBe(0);
});

test("damaged settings fail closed and can be repaired through the settings API", async () => {
  const root = await directory();
  await writeFile(join(root, "model-catalog-settings.json"), "broken");
  let requests = 0;
  const catalog = new ModelCatalog(root, async () => { requests++; return Response.json(registry); });
  expect(await catalog.settings()).toEqual({ onlineUpdatesEnabled: false });
  expect((await modelCatalogResponse(catalog)).status).toBe(503);
  expect(requests).toBe(0);
  await catalog.saveSettings({ onlineUpdatesEnabled: true });
  expect(await catalog.get()).toEqual(registry);
  expect(requests).toBe(1);
});

test("turning off aborts a pending request and cannot accept a late response", async () => {
  const root = await directory();
  const started = Promise.withResolvers<AbortSignal>();
  const result = Promise.withResolvers<Response>();
  const catalog = new ModelCatalog(root, async (_url, options) => {
    if (!options.signal) throw new Error("Missing abort signal");
    started.resolve(options.signal);
    return result.promise;
  });
  const pending = catalog.get();
  const signal = await started.promise;
  await catalog.saveSettings({ onlineUpdatesEnabled: false });
  expect(signal.aborted).toBe(true);
  result.resolve(Response.json(registry));
  await expect(pending).rejects.toThrow();
  await expect(readFile(join(root, "model-catalog.json"))).rejects.toThrow();
});

test("uses a stale saved registry on outage and does not claim manual refresh succeeded", async () => {
  const root = await directory();
  await writeFile(join(root, "model-catalog.json"), JSON.stringify({ fetchedAt: 0, catalog: registry }));
  let requests = 0;
  const catalog = new ModelCatalog(root, async () => { requests++; return Response.json({ error: "unavailable" }, { status: 503 }); });
  expect(await catalog.get()).toEqual(registry);
  expect(await catalog.get()).toEqual(registry);
  expect(requests).toBe(1);
  await expect(catalog.providerModels("anthropic")).rejects.toThrow();
});

test("a redirect from Eigenwelt cannot send the catalog request to another host", async () => {
  let destinationRequests = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    destinationRequests++;
    return Response.json(registry);
  } });
  const mirror = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.redirect(`http://127.0.0.1:${destination.port}/api.json`);
  } });
  stops.push(() => destination.stop(true), () => mirror.stop(true));
  process.env.OPENCODE_MODELS_URL = `http://127.0.0.1:${mirror.port}`;
  const catalog = new ModelCatalog(await directory());
  expect((await modelCatalogResponse(catalog)).status).toBe(503);
  expect(destinationRequests).toBe(0);
});

test("the engine's loopback relay uses the same saved setting before its first request", async () => {
  const root = await directory();
  await writeFile(join(root, "model-catalog-settings.json"), JSON.stringify({ onlineUpdatesEnabled: false }));
  let requests = 0;
  const mirror = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api.json");
    requests++;
    return Response.json(registry);
  } });
  stops.push(() => mirror.stop(true));
  process.env.OPENCODE_MODELS_URL = `http://127.0.0.1:${mirror.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-client-token", hostToken: "test-host-token",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, configPath: join(root, "server.json"),
  };
  const relay = await startModelCatalogRelay(config);
  stops.push(relay.stop);
  const response = await fetch(`${relay.url}/api.json`);
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  expect(requests).toBe(0);
});

test("prepares a plain engine catalog before startup and keeps it current after refresh", async () => {
  const root = await directory();
  let current = registry;
  const mirror = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json(current);
  } });
  stops.push(() => mirror.stop(true));
  process.env.OPENCODE_MODELS_URL = `http://127.0.0.1:${mirror.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-client-token", hostToken: "test-host-token",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, configPath: join(root, "server.json"),
  };
  const relay = await startModelCatalogRelay(config);
  stops.push(relay.stop);
  expect(relay.catalogPath).toBe(join(root, "model-catalog-engine.json"));
  if (!relay.catalogPath) throw new Error("Engine catalog was not prepared");
  expect(JSON.parse(await readFile(relay.catalogPath, "utf8"))).toEqual(registry);
  current = { anthropic: { models: { model: { ...registry.anthropic.models.model, name: "New model" } } } };
  await modelCatalogFor(config).get(true);
  expect(JSON.parse(await readFile(relay.catalogPath, "utf8"))).toEqual(current);
});

test("prepares the saved engine catalog while opted out without making a request", async () => {
  const root = await directory();
  await writeFile(join(root, "model-catalog-settings.json"), JSON.stringify({ onlineUpdatesEnabled: false }));
  await writeFile(join(root, "model-catalog.json"), JSON.stringify({ fetchedAt: 0, catalog: registry }));
  let requests = 0;
  const catalog = new ModelCatalog(root, async () => { requests++; return Response.json(registry); });
  const path = await catalog.engineCatalogPath();
  expect(path).toBe(join(root, "model-catalog-engine.json"));
  if (!path) throw new Error("Saved engine catalog was not prepared");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(registry);
  expect(requests).toBe(0);
});

test("unavailable catalog leaves the engine free to use its bundled snapshot", async () => {
  const catalog = new ModelCatalog(await directory(), async () => Response.json({}, { status: 503 }));
  expect(await catalog.engineCatalogPath()).toBeUndefined();
});
