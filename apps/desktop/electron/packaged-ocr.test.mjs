import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { pruneOcrRuntime } = createRequire(import.meta.url)("../scripts/packaged-ocr.cjs");

test("packaged OCR retains only its target runtime and fails if required payload is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocr-package-"));
  try {
    for (const platform of ["darwin", "win32", "linux"]) for (const arch of ["arm64", "x64"]) {
      const resources = path.join(root, platform, arch), modules = path.join(resources, "app.asar.unpacked/node_modules");
      for (const name of ["onnxruntime-node", "onnxruntime-common", "@napi-rs/canvas", "paddleocr", "image-size"]) {
        const dir = path.join(modules, name); await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
        await writeFile(path.join(dir, "index.js"), "");
      }
      const bin = path.join(modules, "onnxruntime-node/bin/napi-v6");
      for (const os of ["darwin", "win32", "linux"]) for (const cpu of ["arm64", "x64"]) {
        await mkdir(path.join(bin, os, cpu), { recursive: true });
        await writeFile(path.join(bin, os, cpu, "onnxruntime_binding.node"), "fixture");
      }
      await mkdir(path.join(resources, "ocr")); await writeFile(path.join(resources, "ocr/native-worker.cjs"), "");
      pruneOcrRuntime(resources, platform, arch);
      assert.deepEqual(await readdir(bin), [platform]);
      assert.deepEqual(await readdir(path.join(bin, platform)), [arch]);
      assert.throws(() => pruneOcrRuntime(resources, platform, "missing"), /Missing OCR runtime/);
      await rm(path.join(resources, "ocr/native-worker.cjs"));
      assert.throws(() => pruneOcrRuntime(resources, platform, arch), /Missing bundled OCR worker/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
