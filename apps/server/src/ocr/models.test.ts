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
