import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LayoutRuntime } from "./layout-runtime.js";
import type { OcrPage } from "../ocr/types.js";

const fixture = resolve(import.meta.dir, "../../resources/ocr/test-page.png");
const cached = join(process.env.HF_HOME ?? join(process.env.HOME ?? "", ".cache/huggingface"),
  "hub/models--PaddlePaddle--PP-DocLayoutV3_onnx/snapshots/46bbdf188bb0a772c08aed74882ce7e51a8f1ea6/inference.onnx");
const page: OcrPage = { pageNumber: 1, mimeType: "image/png", width: 1000, height: 260, data: new Uint8Array() };

describe("local PP-DocLayoutV3", () => {
  test("rejects invalid pages and cancelled requests before model access", async () => {
    const runtime = new LayoutRuntime({ python: "", workerPath: "", modelDirectory: "/missing" });
    await expect(runtime.detect({ ...page, width: -1 }, new AbortController().signal)).rejects.toThrow();
    await expect(runtime.ensure(new AbortController().signal)).rejects.toThrow("bundled Node OCR runtime");
    const controller = new AbortController(); controller.abort();
    await expect(runtime.detect(page, controller.signal)).rejects.toThrow();
  });

  test("missing layout during document processing never triggers a download", async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-layout-offline-test-"));
    const download = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    try {
      const runtime = new LayoutRuntime({ python: "", workerPath: "", modelDirectory: root,
        native: { executable: "node", workerPath: "", moduleDirectory: "" } });
      await expect(runtime.detect({ ...page, data: await readFile(fixture) }, new AbortController().signal)).rejects.toThrow("Settings → AI Providers");
      expect(download).not.toHaveBeenCalled();
    } finally { download.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  test.skipIf(process.env.LEGALWORK_TEST_LAYOUT_MODEL !== "1" || !existsSync(cached))("detects regions and reading order on a repository page", async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-layout-test-"));
    try {
      const assets = join(root, "pp-doclayout-v3-onnx");
      await mkdir(assets);
      await symlink(cached, join(assets, "inference.onnx"));
      const runtime = new LayoutRuntime({
        python: "", workerPath: "", modelDirectory: root,
        native: { executable: "node", workerPath: resolve(import.meta.dir, "../../resources/ocr/layout-worker.cjs"),
          moduleDirectory: resolve(import.meta.dir, "../../node_modules") },
      });
      const input = { ...page, data: await readFile(fixture) };
      const result = await runtime.detect(input, new AbortController().signal);
      expect(result.model).toBe("pp-doclayout-v3-onnx");
      expect(result.regions.length).toBeGreaterThan(0);
      expect(result.regions.every((region, index) => index === 0 || region.order >= result.regions[index - 1]!.order)).toBe(true);
      expect(result.regions.every((region) => region.box.x >= 0 && region.box.y >= 0 &&
        region.box.x + region.box.width <= 1.000001 && region.box.y + region.box.height <= 1.000001)).toBe(true);
      const controller = new AbortController();
      const cancelled = runtime.detect(input, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await expect(cancelled).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
