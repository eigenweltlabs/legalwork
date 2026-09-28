import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// Official model snapshots, shared with the previous Python installer.
const detector = "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62";
const recognizer = "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513";
export const smallModelAssets = [
  { name: "det.onnx", url: `${detector}/inference.onnx`, bytes: 9880512, sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e" },
  { name: "rec.onnx", url: `${recognizer}/inference.onnx`, bytes: 21159378, sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634" },
  { name: "inference.yml", url: `${recognizer}/inference.yml`, bytes: 150579, sha256: "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1" },
];
export const layoutModelAsset = {
  name: "inference.onnx",
  url: "https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_onnx/resolve/46bbdf188bb0a772c08aed74882ce7e51a8f1ea6/inference.onnx",
  bytes: 130502049,
  sha256: "45bf71750b00739a41fc209f132eb104a4d6b5bb29483c9078164d8b87cf28ba",
};
type Asset = { url: string; bytes: number; sha256: string };

/** Bounded streaming downloads, verified before atomic publication. Complete assets survive retries. */
export async function downloadModelAsset(asset: Asset, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (await assetReady(path, asset, signal)) return;
  // Five minutes plus 1 MB/s, so large models also finish on slower connections. Node requires whole milliseconds.
  const response = await fetch(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000 + Math.ceil(asset.bytes / 1000))]) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > asset.bytes) throw new Error("Could not download OCR model");
  const reader = response.body.getReader(), digest = createHash("sha256"), temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > asset.bytes) throw new Error("OCR model exceeds download limit");
      digest.update(value);
      await file.write(value);
    }
    await file.close();
    if (size !== asset.bytes || digest.digest("hex") !== asset.sha256) throw new Error("OCR model checksum mismatch");
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

// Avoid hashing large assets on every settings poll; recheck whenever a file's metadata changes.
const checkedAssets = new Map<string, { signature: string; ready: boolean }>();
export async function assetReady(path: string, asset: Asset, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size !== asset.bytes) { checkedAssets.delete(path); return false; }
    const signature = `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
    const checked = checkedAssets.get(path);
    if (checked?.signature === signature) return checked.ready;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); digest.update(chunk); }
    const ready = digest.digest("hex") === asset.sha256;
    if (checkedAssets.size >= 32) checkedAssets.clear();
    checkedAssets.set(path, { signature, ready });
    return ready;
  } catch {
    signal?.throwIfAborted(); checkedAssets.delete(path); return false;
  }
}

export async function prepareSmallModel(directory: string, signal: AbortSignal) {
  const assets = join(directory, "pp-ocrv6-small");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  for (const asset of smallModelAssets) await downloadModelAsset(asset, join(assets, asset.name), signal);
  const config = z.object({ PostProcess: z.object({ character_dict: z.array(z.string()).min(1).max(100000) }) }).parse(
    parse(await readFile(join(assets, "inference.yml"), "utf8")),
  );
  const keys = join(assets, "keys.txt");
  await writeFile(keys, config.PostProcess.character_dict.join("\n") + "\n", { mode: 0o600 });
  signal.throwIfAborted();
  const manifest = { version: 1, model: "pp-ocrv6-small", det: join(assets, "det.onnx"), rec: join(assets, "rec.onnx"), keys };
  const temporary = join(directory, `pp-ocrv6-small.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
    signal.throwIfAborted();
    await rename(temporary, join(directory, "pp-ocrv6-small.json"));
  } finally { await rm(temporary, { force: true }); }
}

export async function prepareLayoutModel(directory: string, signal: AbortSignal) {
  const assets = join(directory, "pp-doclayout-v3-onnx");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  await downloadModelAsset(layoutModelAsset, join(assets, layoutModelAsset.name), signal);
}

export async function layoutModelReady(directory: string, signal?: AbortSignal): Promise<boolean> {
  return assetReady(join(directory, "pp-doclayout-v3-onnx", layoutModelAsset.name), layoutModelAsset, signal);
}
