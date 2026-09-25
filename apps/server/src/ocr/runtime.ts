import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OcrSettingsView } from "@legalwork/types/ocr";
import { createLocalOcrEngine, type LocalOcrRuntime } from "./local.js";
import type { LocalEngineSettings } from "./settings.js";
import { ApiError } from "../errors.js";
import { OcrInstaller, runInstallerCommand } from "./installer.js";
import { prepareSmallModel } from "./models.js";

const exists = async (path: string) => access(path).then(() => true, () => false);
export const ocrResources = "resourcesPath" in process && typeof process.resourcesPath === "string" && existsSync(join(process.resourcesPath, "ocr", "worker.py"))
  ? join(process.resourcesPath, "ocr")
  : fileURLToPath(new URL("../../resources/ocr", import.meta.url));

export class OcrRuntime {
  readonly local: LocalOcrRuntime;
  installation: OcrSettingsView["installation"] = null;
  private controller?: AbortController;
  private readonly installer: OcrInstaller;

  constructor(readonly root: string) {
    this.installer = new OcrInstaller(root);
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
        moduleDirectory: packaged ? join(resources, "app.asar.unpacked", "node_modules") : fileURLToPath(new URL("../../node_modules", import.meta.url)),
      },
    };
  }
  supported(model: LocalEngineSettings["model"]) {
    return model === "pp-ocrv6-small" || (process.platform === "darwin" && process.arch === "arm64");
  }
  async available() { return existsSync(join(ocrResources, "native-worker.cjs")); }
  async ready(model: LocalEngineSettings["model"]) {
    if (model === "paddleocr-vl-1.6" && !await exists(this.local.python)) return false;
    if (!await exists(join(this.root, `${model}.ready`))) return false;
    try {
      const manifest: unknown = JSON.parse(await readFile(join(this.local.modelDirectory, `${model}.json`), "utf8"));
      if (!manifest || typeof manifest !== "object") return false;
      const paths = model === "pp-ocrv6-small" ? ["det", "rec", "keys"] : ["path"];
      for (const key of paths) {
        const path = Reflect.get(manifest, key);
        if (typeof path !== "string" || !await exists(path)) return false;
      }
      return true;
    } catch { return false; }
  }
  get busy() { return this.controller !== undefined; }
  cancel() { this.controller?.abort(); }
  async install(engine: LocalEngineSettings) {
    if (this.busy) throw new ApiError(409, "ocr_install_busy", "Another OCR model is being installed.");
    if (!this.supported(engine.model)) throw new ApiError(400, "ocr_unsupported", "This model requires an Apple Silicon Mac.");
    const controller = new AbortController();
    this.controller = controller;
    const stage = (stage: NonNullable<OcrSettingsView["installation"]>["stage"]) => { this.installation = { engineId: engine.id, stage }; };
    stage("runtime");
    void (async () => {
      try {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if (engine.model === "pp-ocrv6-small") {
          stage("models");
          await prepareSmallModel(this.local.modelDirectory, controller.signal);
        } else {
          const uv = await this.installer.ensure(controller.signal);
          if (!await exists(this.local.python)) await runInstallerCommand(uv, ["venv", "--python", "3.12", join(this.root, "venv")], controller.signal);
          stage("dependencies");
          await runInstallerCommand(uv, ["pip", "install", "--python", this.local.python, "-r", join(ocrResources, "requirements-quality.txt")], controller.signal);
          stage("models");
          await runInstallerCommand(this.local.python, [join(ocrResources, "prepare.py"), "--model", engine.model, "--model-dir", this.local.modelDirectory], controller.signal);
        }
        stage("checking");
        const result = await createLocalOcrEngine(engine, this.local).recognize(await ocrTestPage(), {
          languages: ["en", "de"], signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        });
        if (!result.text.trim()) throw new Error("Empty test result");
        controller.signal.throwIfAborted();
        await writeFile(join(this.root, `${engine.model}.ready`), "1\n", { mode: 0o600 });
        stage("complete");
      } catch { stage(controller.signal.aborted ? "cancelled" : "failed"); }
      finally { this.controller = undefined; }
    })();
  }
}

export async function ocrTestPage() {
  return { pageNumber: 1, mimeType: "image/png", width: 1000, height: 260, data: await readFile(join(ocrResources, "test-page.png")) } satisfies import("./types.js").OcrPage;
}
