import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloudOcrRuntime } from "./cloud-ocr.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { OcrManager } from "./ocr/manager.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
const model = "google-document-ocr-eu";
const page = { pageNumber: 1, mimeType: "image/png", width: 1, height: 1,
  data: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64")) } satisfies import("./ocr/types.js").OcrPage;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-cloud-ocr-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config: ServerConfig = {
    configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "owner", hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  let enabled = true, calls = 0, overrideOrigin: string | undefined, onRequest = async () => {};
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/mcp-rest/tools/call");
    expect(request.headers.get("authorization")).toBe("Bearer subscription-secret");
    expect(await request.json()).toMatchObject({ server_id: "synthetic-eu", name: "recognize_page" });
    calls++;
    return Response.json({ structuredContent: { schemaVersion: 1, provider: "google-document-ai", text: "Synthetic contract",
      regions: [{ text: "Synthetic contract", box: { x: 0, y: 0, width: 1, height: 1 } }], truncated: false } });
  } });
  cleanups.push(() => gateway.stop(true));
  const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/api/desktop/ocr") return new Response(null, { status: 404 });
    expect(request.headers.get("authorization")).toBe("Bearer platform-access");
    await onRequest();
    return Response.json({ baseURL: overrideOrigin ?? gateway.url.origin, models: [{ model, name: "Google OCR EU", region: "EU", enabled, available: true,
      serverId: "synthetic-eu", tool: "recognize_page" }] });
  } });
  cleanups.push(() => platform.stop(true));
  const previous = process.env.EIGENWELT_PLATFORM_URL;
  process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
  cleanups.push(() => { if (previous === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = previous; });
  await writeEigenweltConnection(config, { platformURL: platform.url.origin, platformToken: "platform-access", accessTokenExpiresAt: Date.now() + 3600_000,
    account: { userId: "user-test", userName: null, userEmail: "test@example.com", orgId: "org-test", orgName: "Synthetic OCR firm" } });
  await writeCachedEigenweltPaidManifest(config, { baseURL: `${gateway.url.origin}/v1`, apiKey: "subscription-secret", models: [] });
  const runtime = cloudOcrRuntime(config), manager = new OcrManager(join(root, "ocr"), undefined, undefined, runtime);
  return { config, runtime, manager, calls: () => calls, disable: () => { enabled = false; },
    changeOrigin: () => { overrideOrigin = "https://untrusted.example.com"; },
    onRequest: (callback: () => Promise<void>) => { onRequest = callback; } };
}

test("managed Google OCR uses the existing subscription key and normalized page protocol without saving keys", async () => {
  const { manager, calls } = await fixture();
  await manager.setDefault("cloud-google-eu");
  const service = await manager.service();
  expect((await service.extract({ sourceId: "synthetic", pages: [page], languages: [] })).pages[0].text).toBe("Synthetic contract");
  const view = await manager.view();
  expect(view.defaultEngineId).toBe("cloud-google-eu");
  expect(view.engines.find(engine => engine.id === "cloud-google-eu")).toMatchObject({ managed: true, status: "ready" });
  expect(JSON.stringify(view)).not.toContain("subscription-secret");
  expect(JSON.stringify(await manager.store.read())).not.toContain("subscription-secret");
  await expect(manager.removeServer("cloud-google-eu")).rejects.toThrow("Custom OCR model not found");
  expect(calls()).toBe(1);
});

test("an admin disabling OCR blocks an already-created service without another page upload or fallback", async () => {
  const { manager, calls, disable } = await fixture();
  await manager.setDefault("cloud-google-eu");
  const service = await manager.service(); disable();
  await expect(service.extract({ sourceId: "synthetic", pages: [page], languages: [] })).rejects.toThrow("not enabled");
  expect((await manager.view()).engines.find(engine => engine.id === "cloud-google-eu")?.status).toBe("disabled");
  expect(calls()).toBe(0);
});

test("a changed Gateway, unavailable region or sign-out cannot receive the document", async () => {
  const { config, runtime, calls, changeOrigin, onRequest } = await fixture();
  await expect(runtime.recognize("google-document-ocr-us", page, { languages: [], signal: new AbortController().signal })).rejects.toThrow("not enabled");
  changeOrigin();
  await expect(runtime.recognize(model, page, { languages: [], signal: new AbortController().signal })).rejects.toThrow("unavailable");
  onRequest(async () => { await writeEigenweltConnection(config, { platformToken: null, account: null }); });
  expect(await runtime.status(model)).toBe("disconnected");
  expect(calls()).toBe(0);
});
