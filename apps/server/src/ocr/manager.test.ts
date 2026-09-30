import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { OcrManager } from "./manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function manager() {
  const root = await mkdtemp(join(tmpdir(), "ocr-settings-")); roots.push(root);
  return new OcrManager(root);
}
const input = { label: "Multilingual OCR", endpoint: "https://example.com/v1/chat/completions", model: "vision-model", apiKey: "test-secret-123", languages: ["en", "de", "ar", "ja"] };

test("localhost custom APIs can omit authentication, persist their type and become the default", async () => {
  const ocr = await manager();
  for (const kind of ["paddleocr", "mistral-ocr", "chat-completions"]) {
    const id = await ocr.saveServer({ ...input, endpoint: "http://localhost:8080/ocr", kind, authentication: "none", apiKey: undefined });
    await ocr.setDefault(id);
    const view = await new OcrManager(ocr.runtime.root).view();
    expect(view.engines.find((engine) => engine.id === id)).toMatchObject({ kind, authentication: "none", keyConfigured: false, status: "ready" });
    expect(view.defaultEngineId).toBe(id);
    await ocr.removeServer(id);
  }
});

test("auth changes never retain or forward old credentials to another origin", async () => {
  const ocr = await manager();
  const id = await ocr.saveServer(input);
  const original = (await ocr.store.read()).engines.find((engine) => engine.id === id);
  if (!original || original.kind === "local" || !original.apiKeyRef) throw new Error("Missing credential");
  await expect(ocr.saveServer({ ...input, authentication: "none", apiKey: undefined }, id)).rejects.toThrow("localhost");
  const localInput = { ...input, kind: "paddleocr", endpoint: "http://127.0.0.1:8080/layout-parsing", authentication: "none", apiKey: undefined };
  await ocr.saveServer(localInput, id);
  expect(await ocr.vault.get(original.apiKeyRef)).toBeUndefined();
  await expect(ocr.saveServer({ ...localInput, authentication: "api-key" }, id)).rejects.toThrow("Enter an API key");
  await expect(ocr.saveServer({ ...localInput, endpoint: "https://example.com/ocr" }, id)).rejects.toThrow("localhost");
  await ocr.saveServer({ ...localInput, authentication: "api-key", apiKey: "new-key" }, id);
  expect((await ocr.view()).engines.find((engine) => engine.id === id)).toMatchObject({ kind: "paddleocr", authentication: "api-key", keyConfigured: true });
});

test("only a completed local installation can replace the default", async () => {
  const ocr = await manager();
  const serverId = await ocr.saveServer(input);
  await ocr.setDefault(serverId);
  const rejectSelection = async () => {
    await expect(ocr.setDefault("local-fast")).rejects.toThrow("Download and finish setting up");
    expect((await ocr.store.read()).defaultEngineId).toBe(serverId);
  };
  await rejectSelection();
  // Files alone are not enough: the installer must have finished its sample check.
  const { python, modelDirectory } = ocr.runtime.local;
  await mkdir(dirname(python), { recursive: true });
  await mkdir(modelDirectory, { recursive: true });
  await writeFile(python, "test runtime fixture");
  const asset = join(modelDirectory, "test-asset");
  await writeFile(asset, "test model fixture");
  await writeFile(join(modelDirectory, "pp-ocrv6-small.json"), JSON.stringify({ det: asset, rec: asset, cls: asset, keys: asset }));
  await rejectSelection();
  await writeFile(join(ocr.runtime.root, "pp-ocrv6-small.ready"), "1\n");
  await ocr.setDefault("local-fast");
  expect((await ocr.store.read()).defaultEngineId).toBe("local-fast");
  await ocr.setDefault(serverId);
  await rm(asset);
  await rejectSelection();
});

test("server models without stored credentials cannot become the default", async () => {
  const ocr = await manager();
  const id = await ocr.saveServer(input);
  const engine = (await ocr.store.read()).engines.find((item) => item.id === id);
  if (engine?.kind !== "chat-completions" || !engine.apiKeyRef) throw new Error("Missing server engine");
  await ocr.vault.set(engine.apiKeyRef);
  await expect(ocr.setDefault(id)).rejects.toThrow("Add an API key");
  expect((await ocr.store.read()).defaultEngineId).toBe("local-fast");
});

test("persists choices across restarts without exposing API keys or secret references", async () => {
  const ocr = await manager();
  const id = await ocr.saveServer(input);
  await ocr.setDefault(id);
  const reopened = new OcrManager(ocr.runtime.root);
  const view = await reopened.view();
  expect(view.defaultEngineId).toBe(id);
  expect(view.engines.find((engine) => engine.id === id)).toMatchObject({ keyConfigured: true, languages: input.languages });
  expect(JSON.stringify(view)).not.toContain(input.apiKey);
  expect(JSON.stringify(view)).not.toContain("apiKeyRef");
  expect(await readFile(ocr.store.path, "utf8")).not.toContain(input.apiKey);
  expect((await readFile(ocr.vault.path)).includes(Buffer.from(input.apiKey))).toBe(false);
  expect((await stat(ocr.vault.path)).mode & 0o777).toBe(0o600);
});

test("blank key preserves credentials, origin changes require replacement, deletion resets default", async () => {
  const ocr = await manager();
  const id = await ocr.saveServer(input);
  const previous = (await ocr.store.read()).engines.find((engine) => engine.id === id);
  if (previous?.kind !== "chat-completions" || !previous.apiKeyRef) throw new Error("Missing engine");
  await ocr.saveServer({ ...input, label: "Renamed", apiKey: undefined }, id);
  expect(await ocr.vault.get(previous.apiKeyRef)).toBe(input.apiKey);
  await expect(ocr.saveServer({ ...input, endpoint: "https://another.example.com/chat/completions", apiKey: undefined }, id)).rejects.toThrow("Enter an API key");
  await ocr.saveServer({ ...input, apiKey: "replacement" }, id);
  expect(await ocr.vault.get(previous.apiKeyRef)).toBeUndefined();
  await ocr.setDefault(id);
  await ocr.removeServer(id);
  expect((await ocr.view()).defaultEngineId).toBe("local-fast");
  expect((await ocr.view()).engines).toHaveLength(2);
  await expect(ocr.removeServer("local-fast")).rejects.toThrow("Custom OCR model not found");
});

test("rejects unsafe configuration and serializes concurrent updates", async () => {
  const ocr = await manager();
  await expect(ocr.saveServer({ ...input, endpoint: "http://example.com/chat/completions" })).rejects.toThrow("Check the name");
  await expect(ocr.saveServer({ ...input, endpoint: "https://example.com/chat?key=secret" })).rejects.toThrow("Check the name");
  await expect(ocr.saveServer({ ...input, languages: ["not a language"] })).rejects.toThrow("Check the name");
  await expect(ocr.setDefault("unknown")).rejects.toThrow("not found");
  await Promise.all([ocr.saveServer(input), ocr.saveServer({ ...input, label: "Second" })]);
  expect((await ocr.view()).engines).toHaveLength(4);
});

test("sample test uses saved server credentials and returns no model content", async () => {
  let received = false;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${input.apiKey}`);
    const body = await request.text();
    expect(body).toContain("data:image/png;base64,");
    received = true;
    return Response.json({ choices: [{ message: { content: "Agreement English. Vertrag German." }, finish_reason: "stop" }] });
  } });
  try {
    const ocr = await manager();
    const id = await ocr.saveServer({ ...input, endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions` });
    expect(await ocr.test(id)).toEqual({ ok: true });
    expect(received).toBe(true);
  } finally { server.stop(true); }
});
