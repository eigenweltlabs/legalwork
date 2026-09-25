import { execFile } from "node:child_process";
import { contentSchema, OCR_MAX_RESPONSE_BYTES, OcrError } from "./types.js";
import type { OcrEngine, OcrEngineInfo } from "./types.js";
import { localEngineSchema } from "./settings.js";
import type { LocalEngineSettings } from "./settings.js";

export type LocalOcrRuntime = {
  /** Absolute executable and script paths; no shell commands or user-controlled arguments. */
  python: string;
  workerPath: string;
  modelDirectory: string;
};

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false", PYTHONNOUSERSITE: "1" };
}

export function createLocalOcrEngine(input: LocalEngineSettings, runtime: LocalOcrRuntime): OcrEngine {
  const settings = localEngineSchema.parse(input);
  const info: OcrEngineInfo = {
    id: settings.id, label: settings.label, model: settings.model, execution: "local",
    regions: settings.model === "pp-ocrv6-small",
    // Conservative supported subset. Additional scripts need other recognizer packs/adapters.
    languages: settings.model === "pp-ocrv6-small" ? ["en", "de", "fr", "es", "it", "pt", "nl", "id", "vi", "ja", "zh-Hans", "zh-Hant"] : null,
    warnings: settings.model === "pp-ocrv6-small" ? ["fast-model-limitations"] : [],
  };
  return {
    info,
    async recognize(page, context) {
      context.signal.throwIfAborted();
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(runtime.python, [runtime.workerPath, "--model", settings.model, "--model-dir", runtime.modelDirectory], {
          encoding: "utf8", maxBuffer: OCR_MAX_RESPONSE_BYTES, signal: context.signal, killSignal: "SIGKILL",
          env: workerEnvironment(),
        }, (error, stdout) => {
          if (error) {
            // Never forward stderr: it may contain document text, paths, or runtime environment details.
            const unavailable = error.code === "ENOENT" || error.code === 3;
            reject(new OcrError(unavailable ? "runtime-unavailable" : "local-failed", unavailable
              ? "Prepare the selected local OCR runtime and model before extraction."
              : "The local OCR worker failed. Check the runtime installation or select another engine."));
          } else resolve(stdout);
        });
        child.stdin?.on("error", () => { /* execFile reports worker exit/cancellation. */ });
        child.stdin?.end(JSON.stringify({ image: Buffer.from(page.data).toString("base64"), width: page.width, height: page.height }));
      });
      try { return contentSchema.parse(JSON.parse(output)); }
      catch { throw new OcrError("invalid-response", "The local OCR worker returned invalid output."); }
    },
  };
}
