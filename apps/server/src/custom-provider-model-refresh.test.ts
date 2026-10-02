import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCustomProviderModelRefresh, CUSTOM_PROVIDER_REFRESH_MS, readModelRefreshSettings, readStoredProviderApiKey } from "./custom-provider-model-refresh.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-custom-refresh-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let inventory = ["old", "new"];
  let httpStatus = 200;
  let calls = 0;
  let busy = false;
  let reloads = 0;
  let now = 1_000_000;
  let respond: (() => Promise<void>) | undefined;
  let catalogModels: Record<string, unknown> = {};
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls += 1;
    expect(request.headers.get("authorization")).toBe("Bearer refresh-test-key");
    await respond?.();
    return httpStatus === 200 ? Response.json({ data: inventory.map((id) => ({ id })) }) : new Response("Unavailable", { status: httpStatus });
  } });
  cleanup.push(() => { endpoint.stop(true); });
  const workspace: WorkspaceInfo = { id: "ws_refresh", name: "Workspace", path: root, preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
    workspaces: [workspace], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], readOnly: false, startedAt: now, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const oldModel = { name: "My edited model", tool_call: false, reasoning: true, limit: { context: 64000, output: 8000 }, variants: { careful: { reasoningEffort: "high" } } };
  const provider = { npm: "@ai-sdk/openai-compatible", name: "Custom gateway", options: { baseURL: `http://127.0.0.1:${endpoint.port}/v1`, apiKey: "refresh-test-key" }, models: { old: oldModel, manual: { name: "Manual model" } }, whitelist: ["old", "manual"] };
  await writeRuntimeOpencodeConfig(config, workspace.id, () => ({ provider: { custom: provider }, default_agent: "plan" }));
  await writeLegalworkWorkspaceConfig(config, workspace.id, () => ({ customProviderModelRefresh: { custom: { enabled } } }));
  const refresh = createCustomProviderModelRefresh({
    config,
    now: () => now,
    readProviders: async () => (await readRuntimeOpencodeConfig(config, workspace.id)).provider ?? {},
    readCatalogModels: async () => catalogModels,
    isBusy: async () => busy,
    reload: async () => { reloads += 1; },
  });
  return {
    config, workspace, provider, oldModel, refresh,
    runtime: () => readRuntimeOpencodeConfig(config, workspace.id),
    settings: async () => readModelRefreshSettings((await readLegalworkWorkspaceConfig(config, workspace.id)).customProviderModelRefresh),
    get calls() { return calls; }, get reloads() { return reloads; },
    set inventory(value: string[]) { inventory = value; }, set httpStatus(value: number) { httpStatus = value; },
    set busy(value: boolean) { busy = value; }, set respond(value: () => Promise<void>) { respond = value; },
    set catalogModels(value: Record<string, unknown>) { catalogModels = value; },
    advance: (milliseconds = CUSTOM_PROVIDER_REFRESH_MS) => { now += milliseconds; },
  };
}

test("built-in refresh adds catalog metadata, preserves settings and waits for idle", async () => {
  const f = await fixture(false);
  const details = { name: "New built-in model", reasoning: true, tool_call: true, attachment: true, limit: { context: 200000, output: 64000 } };
  f.catalogModels = { old: { name: "Catalog name" }, new: details };
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, current => ({ ...current, provider: {
    ...current.provider, anthropic: { options: { apiKey: "builtin-test-key" }, models: { old: f.oldModel }, whitelist: ["old"] },
  } }));
  f.busy = true;
  const result = await f.refresh(f.workspace, { providerId: "anthropic", force: true, catalog: true });
  expect(result.providers.anthropic.pendingReload).toBe(true);
  expect(result.providers.anthropic.enabled).toBe(false);
  expect(f.calls).toBe(0);
  expect(f.reloads).toBe(0);
  expect((await f.runtime()).provider?.anthropic).toEqual({ options: { apiKey: "builtin-test-key" }, models: { old: f.oldModel, new: details }, whitelist: ["old"] });
  f.busy = false;
  expect((await f.refresh(f.workspace)).reloaded).toBe(true);
  expect((await f.runtime()).default_agent).toBe("plan");
});

test("an authenticated built-in provider can refresh without an existing provider config block", async () => {
  const f = await fixture(false);
  const models = { "new-model": { name: "New model", limit: { context: 100000, output: 8000 } } };
  f.catalogModels = models;
  const result = await f.refresh(f.workspace, { providerId: "anthropic", force: true, catalog: true });
  expect(result.reloaded).toBe(true);
  expect((await f.runtime()).provider?.anthropic).toEqual({ models });
  expect(f.calls).toBe(0);
});

test("refreshes the available inventory without selecting new models; throttles endpoint requests", async () => {
  const f = await fixture();
  const first = await f.refresh(f.workspace);
  expect(first.reloaded).toBe(false);
  expect(first.providers.custom.availableModels).toEqual(["new", "old"]);
  expect((await f.runtime()).provider?.custom).toEqual(f.provider);
  expect((await f.runtime()).default_agent).toBe("plan");
  f.advance(60 * 60 * 1000 - 1);
  await f.refresh(f.workspace);
  expect(f.calls).toBe(1);
  f.inventory = [];
  f.advance(1);
  await f.refresh(f.workspace);
  expect(f.calls).toBe(2);
  expect(f.reloads).toBe(0);
  expect((await f.settings()).custom.availableModels).toEqual([]);
  expect((await f.runtime()).provider?.custom).toHaveProperty("models.old", f.oldModel);
});

test("keeps the available inventory after failure and applies selected model changes only when idle", async () => {
  const f = await fixture();
  f.busy = true;
  const first = await f.refresh(f.workspace, { providerId: "custom", reloadRequired: true });
  expect(first.providers.custom.pendingReload).toBe(true);
  expect(f.reloads).toBe(0);
  f.busy = false;
  expect((await f.refresh(f.workspace)).reloaded).toBe(true);
  expect(f.calls).toBe(1);
  const successful = (await f.settings()).custom.lastUpdatedAt;
  const inventory = await f.runtime();
  f.httpStatus = 401;
  f.advance();
  const failed = await f.refresh(f.workspace);
  expect(failed.providers.custom.lastError).toContain("HTTP 401");
  expect(failed.providers.custom.lastUpdatedAt).toBe(successful);
  expect(failed.providers.custom.availableModels).toEqual(["new", "old"]);
  expect(await f.runtime()).toEqual(inventory);
  await f.refresh(f.workspace);
  expect(f.calls).toBe(2);
});

test("manual providers require opt-in, but explicit refresh bypasses age and automatic mode", async () => {
  const f = await fixture(false);
  await f.refresh(f.workspace);
  expect(f.calls).toBe(0);
  await f.refresh(f.workspace, { providerId: "custom", force: true });
  expect(f.calls).toBe(1);
  expect((await f.settings()).custom.enabled).toBe(false);
  await f.refresh(f.workspace, { providerId: "custom", force: true });
  expect(f.calls).toBe(2);
  f.busy = true;
  await f.refresh(f.workspace, { providerId: "custom", reloadRequired: true });
  expect((await f.settings()).custom.pendingReload).toBe(true);
  expect(f.reloads).toBe(0);
});

test("refresh does not reselect a model the user removed, including after restart", async () => {
  const f = await fixture();
  await f.refresh(f.workspace);
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, current => ({ ...current, provider: {
    custom: { ...f.provider, models: { old: f.oldModel }, whitelist: ["old"] },
  } }));
  await f.refresh(f.workspace, { providerId: "custom", force: true });
  f.inventory = ["old", "new", "newer"];
  f.advance();
  const restartedRefresh = createCustomProviderModelRefresh({
    config: f.config,
    readProviders: async () => (await f.runtime()).provider ?? {},
    isBusy: async () => false,
    reload: async () => { throw new Error("Discovery must not reload the engine"); },
  });
  const result = await restartedRefresh(f.workspace);
  expect(result.providers.custom.availableModels).toEqual(["new", "newer", "old"]);
  expect((await f.runtime()).provider?.custom).toEqual({ ...f.provider, models: { old: f.oldModel }, whitelist: ["old"] });
  expect(result.reloaded).toBe(false);
});

test("coalesces background refreshes and does not restore a disconnected provider", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let requested: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
  f.respond = async () => { requested(); await waiting; };
  const first = f.refresh(f.workspace);
  const second = f.refresh(f.workspace);
  expect(first).toBe(second);
  await requestStarted;
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, (current) => ({ ...current, provider: {} }));
  release();
  await first;
  expect((await f.runtime()).provider).toEqual({});
  expect(f.reloads).toBe(0);
});

test("uses the worker's saved API key without exposing it in refresh status", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-provider-key-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  cleanup.push(async () => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "opencode"));
  await writeFile(join(root, "opencode", "auth.json"), JSON.stringify({ custom: { type: "api", key: "stored-key" } }));
  expect(await readStoredProviderApiKey("custom", {})).toBe("stored-key");
  expect(await readStoredProviderApiKey("other", {})).toBe("");
});

test("a disconnected provider is not restored from the engine's stale config snapshot", async () => {
  const f = await fixture();
  const refresh = createCustomProviderModelRefresh({
    config: f.config,
    readProviders: async () => ({ custom: f.provider }),
    isBusy: async () => false,
    reload: async () => { throw new Error("Must not reload a disconnected provider"); },
  });
  await writeLegalworkWorkspaceConfig(f.config, f.workspace.id, () => ({ customProviderModelRefresh: { custom: { enabled: false, disconnected: true } } }));
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ provider: {} }));
  await refresh(f.workspace, { providerId: "custom", force: true });
  expect(f.calls).toBe(0);
  expect((await f.runtime()).provider).toEqual({});
});
