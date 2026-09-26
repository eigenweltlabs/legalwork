import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfiguredOcrService, createLocalOcrEngine, createServerOcrEngine, defaultOcrSettings, OcrError, OcrService, OcrSettingsStore, serverEngineSchema, settingsSchema } from "./index.js";
import type { OcrContent, OcrEngine, OcrPage, OcrProgress, OcrRequest } from "./index.js";

const page: OcrPage = { pageNumber: 1, mimeType: "image/png", width: 100, height: 50, data: new Uint8Array([1, 2, 3]) };
const request: OcrRequest = { sourceId: "document-123", pages: [page], languages: ["en", "de"] };
const content: OcrContent = { text: "Agreement / Vertrag", regions: [{ text: "Agreement / Vertrag", box: { x: 0.1, y: 0.2, width: 0.5, height: 0.2 }, confidence: 0.9 }], truncated: false };
function engine(id = "local-fast", recognize: OcrEngine["recognize"] = async () => content): OcrEngine {
  return { info: { id, label: id, model: "fixture", execution: "local", regions: true, languages: ["en", "de"], warnings: ["fast-model-limitations"] }, recognize };
}
const serverSettings = () => serverEngineSchema.parse({ id: "server", label: "My OCR server", kind: "chat-completions", model: "vision-ocr", endpoint: "https://ocr.example.test/v1/chat/completions", apiKeyRef: "vault/ocr-server" });
function completion(text = "Agreement", finish_reason = "stop") {
  return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason }] }));
}

describe("OCR service", () => {
  test("default is local; preserves source identity, coordinates, warnings and progress", async () => {
    const progress: OcrProgress[] = [];
    const result = await new OcrService([engine()]).extract({ ...request, pages: [page, { ...page, pageNumber: 3 }], onProgress: (event) => progress.push(event) });
    expect(result.engine.execution).toBe("local");
    expect(result.sourceId).toBe("document-123");
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 3]);
    expect(result.pages[0]?.regions).toEqual(content.regions);
    expect(result.pages[0]?.imageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.warnings).toContain("fast-model-limitations");
    expect(progress.map((event) => event.stage)).toEqual(["started", "page-started", "page-completed", "page-started", "page-completed", "completed"]);
    expect(progress.at(-1)?.completedPages).toBe(2);
  });
  test("explicit override, no automatic fallback after failure", async () => {
    let localCalls = 0;
    let alternateCalls = 0;
    const local = engine("local-fast", async () => { localCalls++; throw new Error("private document text"); });
    const alternate = engine("other", async () => { alternateCalls++; return content; });
    const service = new OcrService([local, alternate]);
    await expect(service.extract(request)).rejects.toMatchObject({ code: "invalid-response", message: "OCR processing failed." });
    expect(alternateCalls).toBe(0);
    expect((await service.extract({ ...request, engineId: "other" })).engine.id).toBe("other");
    expect(localCalls).toBe(1);
  });
  test("rejects unsupported languages and invalid requests before invoking engines", async () => {
    let calls = 0;
    const service = new OcrService([engine("local-fast", async () => { calls++; return content; })]);
    await expect(service.extract({ ...request, languages: ["ar"] })).rejects.toMatchObject({ code: "unsupported-language" });
    await expect(service.extract({ ...request, languages: ["not a language"] })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(service.extract({ ...request, pages: [page, page] })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(service.extract({ ...request, pages: [{ ...page, width: 20000, height: 20000 }] })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(service.extract({ ...request, pages: [{ ...page, data: new Uint8Array(0) }] })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(service.extract({ ...request, engineId: "missing" })).rejects.toMatchObject({ code: "unknown-engine" });
    expect(calls).toBe(0);
    await service.extract({ ...request, languages: ["en-GB", "de-DE"] });
  });
  test("rejects invalid region coordinates; exposes empty/truncated output", async () => {
    const invalid = new OcrService([engine("local-fast", async () => ({ ...content, regions: [{ text: "bad", box: { x: 0.9, y: 0, width: 0.5, height: 0.1 } }] }))]);
    await expect(invalid.extract(request)).rejects.toMatchObject({ code: "invalid-response" });
    const empty = new OcrService([engine("local-fast", async () => ({ text: "", regions: [], truncated: true }))]);
    expect((await empty.extract(request)).pages[0]?.warnings).toContain("empty-text");
    expect((await empty.extract(request)).pages[0]?.warnings).toContain("output-truncated");
  });
  test("timeout also bounds a stalled adapter; active cancellation stops further pages", async () => {
    const stalled = new OcrService([engine("local-fast", () => new Promise(() => {}))], "local-fast", 15);
    await expect(stalled.extract(request)).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    let calls = 0;
    const service = new OcrService([engine("local-fast", async () => { calls++; return content; })]);
    await expect(service.extract({ ...request, pages: [page, { ...page, pageNumber: 2 }], signal: controller.signal, onProgress: (event) => {
      if (event.stage === "page-completed") controller.abort();
    } })).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(1);
  });
  test("serializes jobs and cancels a queued job without starting it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const service = new OcrService([engine("local-fast", async () => { calls++; await gate; return content; })]);
    const first = service.extract(request);
    const controller = new AbortController();
    const second = service.extract({ ...request, signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
    release();
    await first;
    await service.extract(request);
    expect(calls).toBe(2);
  });
  test("rejects duplicate engines and unavailable default engines", () => {
    expect(() => new OcrService([engine(), engine()])).toThrow();
    expect(() => new OcrService([engine()], "missing")).toThrow();
  });
});

describe("server OCR adapter", () => {
  test("sends only the selected page to an actual loopback endpoint with a separately resolved key", async () => {
    const received: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer fixture-key");
      received.push(await req.text());
      return completion("Server transcription");
    } });
    try {
      const profile = serverSettings(); profile.endpoint = `${server.url}v1/chat/completions`;
      const remote = createServerOcrEngine(profile, async (reference) => reference === "vault/ocr-server" ? "fixture-key" : undefined);
      const service = new OcrService([engine(), remote]);
      await service.extract(request);
      expect(received).toHaveLength(0);
      const events: OcrProgress[] = [];
      const result = await service.extract({ ...request, engineId: "server", onProgress: (event) => events.push(event) });
      expect(result.pages[0]?.text).toBe("Server transcription");
      expect(result.pages[0]?.regions).toEqual([]);
      expect(result.warnings).toContain("remote-processing");
      expect(result.warnings).toContain("regions-unavailable");
      expect(events[0]?.engine.execution).toBe("remote");
      expect(received[0]).toContain("data:image/png;base64,AQID");
      expect(received[0]).not.toContain("document-123");
      expect(JSON.stringify(result)).not.toContain("fixture-key");
    } finally { server.stop(true); }
  });
  test("missing keys never send a request; errors do not expose provider bodies or secret failures", async () => {
    const remote = createServerOcrEngine(serverSettings(), async () => undefined, async () => { throw new Error("must not call"); });
    await expect(new OcrService([remote], "server").extract(request)).rejects.toMatchObject({ code: "missing-api-key" });
    const rejected = createServerOcrEngine(serverSettings(), async () => "private-key", async () => new Response("private-key and document text", { status: 401 }));
    await expect(new OcrService([rejected], "server").extract(request)).rejects.toMatchObject({ code: "server-failed", message: "The OCR server rejected the request (HTTP 401)." });
    const brokenSecret = createServerOcrEngine(serverSettings(), async () => { throw new Error("private-key"); });
    await expect(new OcrService([brokenSecret], "server").extract(request)).rejects.toMatchObject({ message: "The OCR API key could not be accessed." });
  });
  test("rejects redirects, malformed responses and refusals; flags output limits", async () => {
    const settings = serverSettings();
    const remote = createServerOcrEngine(settings, async () => "key", async (_url, options) => {
      expect(options.redirect).toBe("error"); return completion("partial", "length");
    });
    expect((await new OcrService([remote], "server").extract(request)).pages[0]?.warnings).toContain("output-truncated");
    for (const body of [{ choices: [] }, { choices: [{ message: { content: "", refusal: "refused" }, finish_reason: "stop" }] }]) {
      const invalid = createServerOcrEngine(settings, async () => "key", async () => new Response(JSON.stringify(body)));
      await expect(new OcrService([invalid], "server").extract(request)).rejects.toMatchObject({ code: "invalid-response" });
    }
    const huge = createServerOcrEngine(settings, async () => "key", async () => new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(new OcrService([huge], "server").extract(request)).rejects.toMatchObject({ code: "invalid-response" });
  });
  test("does not send after cancellation while resolving the key", async () => {
    const controller = new AbortController();
    let sent = false;
    const remote = createServerOcrEngine(serverSettings(), async () => { controller.abort(); return "key"; }, async () => { sent = true; return completion(); });
    await expect(new OcrService([remote], "server").extract({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(sent).toBe(false);
  });
});

describe("configuration and local process boundary", () => {
  let directory = "";
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "legalwork-ocr-test-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  test("settings persist engine choice, never API keys; missing configuration defaults to local", async () => {
    const store = new OcrSettingsStore(join(directory, "ocr.json"));
    const settings = await store.read();
    expect(settings.defaultEngineId).toBe("local-fast");
    settings.engines.push(serverSettings()); settings.defaultEngineId = "server";
    await store.write(settings);
    expect(await store.read()).toEqual(settings);
    expect(settingsSchema.safeParse({ ...settings, apiKey: "do-not-save" }).success).toBe(false);
    expect(serverEngineSchema.safeParse({ ...serverSettings(), apiKey: "do-not-save" }).success).toBe(false);
    if (process.platform !== "win32") expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await writeFile(store.path, "broken");
    await expect(store.read()).rejects.toMatchObject({ code: "invalid-input" });
  });
  test("rejects insecure remote endpoints and credential-bearing URLs", () => {
    for (const endpoint of ["http://example.com/ocr", "https://user:password@example.com/ocr", "https://example.com/ocr?key=secret", "file:///tmp/ocr"]) {
      expect(serverEngineSchema.safeParse({ ...serverSettings(), endpoint }).success).toBe(false);
    }
    expect(serverEngineSchema.safeParse({ ...serverSettings(), endpoint: "http://127.0.0.1:8000/v1/chat/completions" }).success).toBe(true);
  });
  test("worker protocol passes bytes over stdin and rejects unavailable runtimes", async () => {
    const workerPath = join(directory, "fixture-worker.mjs");
    await writeFile(workerPath, `import { readFileSync } from 'node:fs'; const input = JSON.parse(readFileSync(0, 'utf8')); if (input.image !== 'AQID' || process.env.HF_HUB_OFFLINE !== '1') process.exit(4); process.stdout.write(JSON.stringify({text:'fixture', regions:[], truncated:false}));`);
    const runtime = { python: process.execPath, workerPath, modelDirectory: directory };
    const service = createConfiguredOcrService(defaultOcrSettings(), { localRuntime: runtime, resolveApiKey: async () => undefined });
    expect((await service.extract(request)).pages[0]?.text).toBe("fixture");
    const missing = createLocalOcrEngine({ id: "local-fast", label: "Fast", kind: "local", model: "pp-ocrv6-small" }, { ...runtime, python: join(directory, "missing-python") });
    await expect(new OcrService([missing]).extract(request)).rejects.toBeInstanceOf(OcrError);
    await expect(new OcrService([missing]).extract(request)).rejects.toMatchObject({ code: "runtime-unavailable" });
  });
  test("local workers do not inherit host secrets, and timeouts kill slow workers", async () => {
    const workerPath = join(directory, "private-worker.mjs");
    process.env.LEGALWORK_OCR_TEST_SECRET = "private-host-key";
    try {
      await writeFile(workerPath, `if (process.env.LEGALWORK_OCR_TEST_SECRET) process.exit(4); process.stdout.write(JSON.stringify({text:'isolated', regions:[], truncated:false}));`);
      const local = createLocalOcrEngine({ id: "local-fast", label: "Fast", kind: "local", model: "pp-ocrv6-small" }, { python: process.execPath, workerPath, modelDirectory: directory });
      expect((await new OcrService([local]).extract(request)).pages[0]?.text).toBe("isolated");
      await writeFile(workerPath, `setTimeout(() => process.stdout.write('{}'), 30000);`);
      await expect(new OcrService([local], "local-fast", 30).extract(request)).rejects.toMatchObject({ code: "timeout" });
    } finally { delete process.env.LEGALWORK_OCR_TEST_SECRET; }
  });
});

// Opt-in real model test: provisioning must happen explicitly, never in a default test run.
const smokePython = process.env.LEGALWORK_OCR_SMOKE_PYTHON;
const smokeModels = process.env.LEGALWORK_OCR_SMOKE_MODELS;
test.skipIf(!smokePython || !smokeModels)("real local worker extracts English/German text and normalized regions", async () => {
  if (!smokePython || !smokeModels) return;
  const data = await readFile(new URL("./fixtures/bilingual.png", import.meta.url));
  const service = createConfiguredOcrService(defaultOcrSettings(), {
    localRuntime: { python: smokePython, modelDirectory: smokeModels, workerPath: resolve(import.meta.dir, "../../resources/ocr/worker.py") },
    resolveApiKey: async () => undefined,
  });
  for (const engineId of ["local-fast", "local-quality"]) {
    if (engineId === "local-quality" && (process.platform !== "darwin" || process.arch !== "arm64")) continue;
    const result = await service.extract({ sourceId: "synthetic-smoke-fixture", engineId, languages: ["en", "de"], pages: [{ ...page, width: 1000, height: 260, data }] });
    expect(result.pages[0]?.text).toContain("Agreement");
    expect(result.pages[0]?.text).toContain("Vertrag");
    if (engineId === "local-fast") expect(result.pages[0]?.regions.length).toBeGreaterThan(0);
    else expect(result.warnings).toContain("regions-unavailable");
  }
}, 120000);
