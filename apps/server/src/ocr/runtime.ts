import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OcrSettingsView } from "@legalwork/types/ocr";
import { createLocalOcrEngine, type LocalOcrRuntime } from "./local.js";
import type { LocalEngineSettings } from "./settings.js";
import { ApiError } from "../errors.js";
import { LayoutRuntime } from "../document-preparation/layout-runtime.js";
import { prepareSmallModel, prepareLayoutModel, layoutModelReady } from "./models.js";
import { llamaSupported, prepareQualityModel, qualityModelReady } from "./llama.js";

const exists = async (path: string) => access(path).then(() => true, () => false);
export const ocrResources = process.env.LEGALWORK_RESOURCES_DIR
  ? join(process.env.LEGALWORK_RESOURCES_DIR, "ocr")
  : "resourcesPath" in process && typeof process.resourcesPath === "string" && existsSync(join(process.resourcesPath, "ocr", "worker.py"))
  ? join(process.resourcesPath, "ocr")
  : fileURLToPath(new URL("../../resources/ocr", import.meta.url));

export class OcrRuntime {
  readonly local: LocalOcrRuntime;
  installation: OcrSettingsView["installation"] = null;
  private controller?: AbortController;

  constructor(readonly root: string) {
    const resources = "resourcesPath" in process && typeof process.resourcesPath === "string" ? process.resourcesPath : undefined;
    const bundledNode = resources ? join(resources, "node", process.platform === "win32" ? "node.exe" : "node") : undefined;
    const packaged = resources && existsSync(join(resources, "app.asar"));
    this.local = {
      python: join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      workerPath: join(ocrResources, "worker.py"),
      modelDirectory: join(root, "models"),
      native: {
        executable: bundledNode && existsSync(bundledNode) ? bundledNode : process.versions.electron ? "node" : process.execPath,
        workerPath: join(ocrResources, "native-worker.cjs"),
        launcherPath: join(ocrResources, "llama-launcher.cjs"),
        moduleDirectory: process.env.LEGALWORK_NATIVE_MODULES_DIR ?? (packaged ? join(resources, "app.asar.unpacked", "node_modules") : fileURLToPath(new URL("../../node_modules", import.meta.url))),
      },
    };
  }
  supported(model: LocalEngineSettings["model"]) {
    return model === "pp-ocrv6-small" || llamaSupported();
  }
  async available() { return existsSync(join(ocrResources, "native-worker.cjs")); }
  async ready(model: LocalEngineSettings["model"]) {
    if (!await exists(join(this.root, `${model}.ready`)) || !await this.smallModelReady()) return false;
    // The quality model uses the fast model's line detector to find text outside layout blocks.
    // Earlier installs that ran it in Python have no llama.cpp files and are prepared again.
    return model === "pp-ocrv6-small" || qualityModelReady(this.local.modelDirectory);
  }
  private async smallModelReady() {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(this.local.modelDirectory, "pp-ocrv6-small.json"), "utf8"));
      if (!manifest || typeof manifest !== "object") return false;
      for (const key of ["det", "rec", "keys"]) {
        const path = Reflect.get(manifest, key);
        if (typeof path !== "string" || !await exists(path)) return false;
      }
      return true;
    } catch { return false; }
  }
  get busy() { return this.controller !== undefined; }
  cancel() { this.controller?.abort(); }
  async layoutReady() { return layoutModelReady(this.local.modelDirectory); }
  private async prepareLayout(signal: AbortSignal, stage: (value: NonNullable<OcrSettingsView["installation"]>["stage"], id?: string) => void) {
    stage("models", "local-layout");
    await prepareLayoutModel(this.local.modelDirectory, signal);
    stage("checking");
    const layout = new LayoutRuntime(this.local);
    const result = await layout.detect(await ocrTestPage(), signal).finally(() => layout.close());
    if (!result.regions.length) throw new Error("No layout regions in sample");
  }
  private startInstall(id: string, work: (signal: AbortSignal, stage: (value: NonNullable<OcrSettingsView["installation"]>["stage"], id?: string) => void) => Promise<void>) {
    if (this.busy) throw new ApiError(409, "ocr_install_busy", "Another local model is being installed.");
    const controller = new AbortController();
    this.controller = controller;
    const stage = (value: NonNullable<OcrSettingsView["installation"]>["stage"], target = this.installation?.engineId ?? id) => {
      this.installation = { engineId: target, stage: value };
    };
    stage("runtime", id);
    void (async () => {
      try {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await work(controller.signal, stage);
        controller.signal.throwIfAborted();
        stage("complete");
      } catch { stage(controller.signal.aborted ? "cancelled" : "failed"); }
      finally { this.controller = undefined; }
    })();
  }
  async installLayout() {
    this.startInstall("local-layout", (signal, stage) => this.prepareLayout(signal, stage));
  }
  async install(engine: LocalEngineSettings) {
    if (!this.supported(engine.model)) throw new ApiError(400, "ocr_unsupported", "This model requires an Apple Silicon Mac.");
    this.startInstall(engine.id, async (signal, stage) => {
      if (engine.model === "pp-ocrv6-small") {
        stage("models");
        await prepareSmallModel(this.local.modelDirectory, signal);
      } else {
        stage("models");
        await prepareQualityModel(this.local.modelDirectory, signal);
        await prepareSmallModel(this.local.modelDirectory, signal);
      }
      stage("checking");
      const check = createLocalOcrEngine(engine, this.local);
      const result = await check.recognize(await ocrTestPage(), {
        languages: ["en", "de"], signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      }).finally(() => check.close?.());
      if (!result.text.trim()) throw new Error("Empty test result");
      signal.throwIfAborted();
      await writeFile(join(this.root, `${engine.model}.ready`), "1\n", { mode: 0o600 });
      if (!await this.layoutReady()) await this.prepareLayout(signal, stage);
    });
  }

}

export async function ocrTestPage() {
  return { pageNumber: 1, mimeType: "image/png", width: 1000, height: 260, data: await readFile(join(ocrResources, "test-page.png")) } satisfies import("./types.js").OcrPage;
}
