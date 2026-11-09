import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadModelAsset } from "./models.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const bytes = Buffer.from("verified-model-fixture");
const asset = { name: "model.onnx", url: "https://example.invalid/model", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };

test("model downloads publish verified bytes and reuse complete assets without network", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-model-")); roots.push(root);
  const path = join(root, asset.name), download = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
  try {
    await downloadModelAsset(asset, path, new AbortController().signal);
    expect(await readFile(path)).toEqual(bytes);
    await downloadModelAsset(asset, path, new AbortController().signal);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([asset.name]);
  } finally { download.mockRestore(); }
});

test("a host download transport receives the bounded abort signal and verified assets are reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-proxy-")); roots.push(root);
  const direct = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Direct networking must not be used"));
  let requests = 0;
  const download = async (url: string, init: { signal: AbortSignal }) => {
    requests++;
    expect(url).toBe(asset.url);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return new Response(bytes);
  };
  try {
    const path = join(root, asset.name);
    await downloadModelAsset(asset, path, new AbortController().signal, download);
    await downloadModelAsset(asset, path, new AbortController().signal, download);
    expect(await readFile(path)).toEqual(bytes);
    expect(requests).toBe(1);
    expect(direct).not.toHaveBeenCalled();
  } finally { direct.mockRestore(); }
});

test("corruption, over-limit streams and cancellation cannot publish a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-model-")); roots.push(root);
  const path = join(root, asset.name), download = spyOn(globalThis, "fetch").mockResolvedValue(new Response("corrupt"));
  try {
    await expect(downloadModelAsset(asset, path, new AbortController().signal)).rejects.toThrow("checksum");
    download.mockResolvedValue(new Response(Buffer.alloc(bytes.length + 1)));
    await expect(downloadModelAsset(asset, path, new AbortController().signal)).rejects.toThrow("limit");
    const controller = new AbortController(); controller.abort();
    await expect(downloadModelAsset(asset, path, controller.signal)).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual([]);
  } finally { download.mockRestore(); }
});

test("file transfer reports byte progress and mid-transfer cancellation keeps no partial model", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-progress-")); roots.push(root);
  const events: number[] = [];
  const transport = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close(); },
  }));
  const path = join(root, asset.name);
  await downloadModelAsset(asset, path, new AbortController().signal, transport, (received, total) => {
    expect(total).toBe(bytes.length); events.push(received);
  });
  expect(events).toEqual([0, 5, bytes.length]);
  await rm(path);
  const controller = new AbortController();
  await expect(downloadModelAsset(asset, path, controller.signal, transport, received => {
    if (received > 0) controller.abort();
  })).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});
