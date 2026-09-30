import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { OcrManager } from "./manager.js";
import * as models from "./models.js";
import * as local from "./local.js";
import { OcrRuntime } from "./runtime.js";
import { LayoutRuntime } from "../document-preparation/layout-runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ocr-setup-")); roots.push(root);
  const runtime = new OcrRuntime(root), calls: string[] = [];
  const small = spyOn(models, "prepareSmallModel").mockImplementation(async () => { calls.push("small-download"); });
  const layout = spyOn(models, "prepareLayoutModel").mockImplementation(async () => {
    expect(runtime.installation).toEqual({ engineId: "local-layout", stage: "models" }); calls.push("layout-download");
  });
  const ready = spyOn(runtime, "layoutReady").mockResolvedValue(false);
  const ocr = spyOn(local, "createLocalOcrEngine").mockReturnValue({
    info: { id: "local-fast", model: "pp-ocrv6-small", label: "Small", execution: "local", languages: null, regions: true, warnings: [] },
    async recognize() { calls.push("small-check"); return { text: "Sample", regions: [], truncated: false }; },
  });
  const check = spyOn(LayoutRuntime.prototype, "detect").mockImplementation(async () => {
    expect(runtime.installation).toEqual({ engineId: "local-layout", stage: "checking" }); calls.push("layout-check");
    return { model: "pp-doclayout-v3-onnx", regions: [{ label: "text", box: { x: .1, y: .1, width: .8, height: .1 }, confidence: .9, order: 0 }] };
  });
  return { root, runtime, calls, layout, ready, restore: () => { small.mockRestore(); layout.mockRestore(); ready.mockRestore(); ocr.mockRestore(); check.mockRestore(); } };
}
async function done(runtime: OcrRuntime) {
  for (let i = 0; i < 100 && runtime.busy; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(runtime.busy).toBe(false);
}

test("small OCR installation downloads and checks shared layout in the same setup", async () => {
  const { runtime, calls, restore } = await setup();
  try {
    await runtime.install({ id: "local-fast", label: "Small", kind: "local", model: "pp-ocrv6-small" });
    await done(runtime);
    expect(calls).toEqual(["small-download", "small-check", "layout-download", "layout-check"]);
    expect(runtime.installation).toEqual({ engineId: "local-layout", stage: "complete" });
  } finally { restore(); }
});

test("layout failure retains installed OCR and layout retry does not repeat OCR", async () => {
  const { root, runtime, calls, layout, restore } = await setup();
  try {
    layout.mockImplementationOnce(async () => { throw new Error("offline"); });
    await runtime.install({ id: "local-fast", label: "Small", kind: "local", model: "pp-ocrv6-small" });
    await done(runtime);
    expect(runtime.installation).toEqual({ engineId: "local-layout", stage: "failed" });
    expect(await access(join(root, "pp-ocrv6-small.ready")).then(() => true, () => false)).toBe(true);
    await runtime.installLayout(); await done(runtime);
    expect(calls.filter(call => call.startsWith("small"))).toEqual(["small-download", "small-check"]);
    expect(runtime.installation).toEqual({ engineId: "local-layout", stage: "complete" });
  } finally { restore(); }
});

test("layout download cancellation is visible and concurrent installs are rejected", async () => {
  const { runtime, layout, restore } = await setup();
  let entered!: () => void;
  const downloading = new Promise<void>(resolve => { entered = resolve; });
  try {
    layout.mockImplementation(async (_directory, signal) => { entered(); await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }); });
    await runtime.installLayout(); await downloading;
    await expect(runtime.installLayout()).rejects.toThrow("Another local model");
    runtime.cancel(); await done(runtime);
    expect(runtime.installation).toEqual({ engineId: "local-layout", stage: "cancelled" });
  } finally { runtime.cancel(); restore(); }
});

const cachedLayout = join(homedir(), ".cache/huggingface/hub/models--PaddlePaddle--PP-DocLayoutV3_onnx/snapshots/46bbdf188bb0a772c08aed74882ce7e51a8f1ea6/inference.onnx");
test.skipIf(process.env.LEGALWORK_TEST_LAYOUT_MODEL !== "1" || !existsSync(cachedLayout))("startup installs and verifies the real layout model when OCR is already installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-layout-real-")); roots.push(root);
  const manager = new OcrManager(root);
  const ocrReady = spyOn(manager.runtime, "ready").mockResolvedValue(true);
  const download = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: URL | RequestInfo) => {
    expect(String(input)).toBe(models.layoutModelAsset.url);
    return new Response(Bun.file(cachedLayout));
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await manager.downloadDefaultIfNeeded();
    for (let i = 0; i < 600 && manager.runtime.busy; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(manager.runtime.busy).toBe(false);
    expect(manager.runtime.installation).toEqual({ engineId: "local-layout", stage: "complete" });
    expect((await manager.view()).layout?.status).toBe("ready");
    expect(download).toHaveBeenCalledTimes(1);
    const reopened = new OcrManager(root);
    spyOn(reopened.runtime, "ready").mockResolvedValue(true);
    await reopened.downloadDefaultIfNeeded();
    expect(reopened.runtime.installation).toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  } finally { manager.stop(); download.mockRestore(); ocrReady.mockRestore(); }
}, 40_000);
