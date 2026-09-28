import { execFile } from "node:child_process";
import { z } from "zod";
import { boxSchema, contentSchema, OCR_MAX_RESPONSE_BYTES, OcrError } from "./types.js";
import type { OcrEngine, OcrEngineInfo } from "./types.js";
import { localEngineSchema } from "./settings.js";
import type { LocalEngineSettings } from "./settings.js";
import { pageInput, readBlocks, type VlAnswer, type VlRequest } from "./vl-blocks.js";
import { LlamaServer, readers } from "./llama.js";
import { WorkerProcess } from "./worker-process.js";

export type LocalOcrRuntime = {
  /** Absolute executable and script paths; no shell commands or user-controlled arguments. */
  python: string;
  workerPath: string;
  modelDirectory: string;
  /** Bundled Node: the small-model worker, and the launcher that ties llama-server to this process.
   * Python remains only as a fallback for the small model where the bundled worker is missing. */
  native?: { executable: string; workerPath: string; moduleDirectory: string; launcherPath?: string };
};

/** Reads crops with the quality model; tests substitute their own. */
export type VlReader = { read(request: VlRequest, signal: AbortSignal): Promise<VlAnswer>; close(): void };

const unavailable = "Prepare the selected local OCR runtime and model before extraction.";
const failed = "The local OCR worker failed. Check the runtime installation or select another engine.";

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false", PYTHONNOUSERSITE: "1" };
}

function runWorker(executable: string, args: string[], env: NodeJS.ProcessEnv, input: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(executable, args, { encoding: "utf8", maxBuffer: OCR_MAX_RESPONSE_BYTES, signal, killSignal: "SIGKILL", env }, (error, stdout) => {
      if (error) {
        // Never forward stderr: it may contain document text, paths, or runtime environment details.
        const missing = error.code === "ENOENT" || error.code === 3;
        reject(new OcrError(missing ? "runtime-unavailable" : "local-failed", missing ? unavailable : failed));
      } else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* execFile reports worker exit/cancellation. */ });
    child.stdin?.end(input);
  });
}

export function createLocalOcrEngine(input: LocalEngineSettings, runtime: LocalOcrRuntime, reader?: VlReader): OcrEngine {
  const settings = localEngineSchema.parse(input);
  const info: OcrEngineInfo = {
    id: settings.id, label: settings.label, model: settings.model, execution: "local",
    regions: settings.model === "pp-ocrv6-small",
    // Conservative supported subset. Additional scripts need other recognizer packs/adapters.
    languages: settings.model === "pp-ocrv6-small" ? ["en", "de", "fr", "es", "it", "pt", "nl", "id", "vi", "ja", "zh-Hans", "zh-Hant"] : null,
    warnings: settings.model === "pp-ocrv6-small" ? ["fast-model-limitations"] : [],
  };
  // Loaded on first use and kept for every page until the engine is closed or idle.
  let native: WorkerProcess | undefined, quality = reader;
  const nativeWorker = () => {
    if (!runtime.native) throw new OcrError("runtime-unavailable", unavailable);
    return native ??= new WorkerProcess({
      executable: runtime.native.executable, args: [runtime.native.workerPath, "--model", "pp-ocrv6-small", "--model-dir", runtime.modelDirectory],
      env: { ...workerEnvironment(), NODE_PATH: runtime.native.moduleDirectory, BUN_BE_BUN: "1" }, maxReply: OCR_MAX_RESPONSE_BYTES, unavailable, failed,
    });
  };
  const qualityModel = () => {
    if (quality) return quality;
    if (!runtime.native?.launcherPath) throw new OcrError("runtime-unavailable", unavailable);
    return quality = new LlamaServer(runtime.modelDirectory, { executable: runtime.native.executable, script: runtime.native.launcherPath, env: { ...workerEnvironment(), BUN_BE_BUN: "1" } });
  };
  return {
    info,
    async recognize(page, context) {
      context.signal.throwIfAborted();
      const image = { image: Buffer.from(page.data).toString("base64"), width: page.width, height: page.height };
      const invalid = () => new OcrError("invalid-response", "The local OCR worker returned invalid output.");
      if (settings.model === "pp-ocrv6-small") {
        const output = runtime.native ? await nativeWorker().request(image, context.signal)
          : await runWorker(runtime.python, [runtime.workerPath, "--model", settings.model, "--model-dir", runtime.modelDirectory], workerEnvironment(), JSON.stringify(image), context.signal);
        try { return contentSchema.parse(typeof output === "string" ? JSON.parse(output) : output); } catch { throw invalid(); }
      }
      // Crops go to the server's reading slots in page order; answers keep that order.
      const read = async (requests: VlRequest[]) => {
        const answers: VlAnswer[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(readers, requests.length) }, async () => {
          for (let index = next++; index < requests.length; index = next++) {
            // After a failed crop the page fails: the other slot stops too.
            try { answers[index] = await qualityModel().read(requests[index]!, context.signal); } catch (error) { next = requests.length; throw error; }
          }
        }));
        return answers;
      };
      const whole = async () => {
        const [answer] = await read([{ image: await pageInput(page), prompt: "OCR:", limit: 4096 }]);
        return contentSchema.parse({ text: answer!.cut ? "" : answer!.text.trim(), regions: [], truncated: answer!.cut });
      };
      // Without layout the whole page is read.
      if (!page.blocks) return whole();
      // The fast model's line detector finds text outside the layout blocks for the quality model to read.
      let lines;
      try { lines = z.object({ lines: z.array(boxSchema).max(20000) }).parse(await nativeWorker().request({ ...image, detectOnly: true }, context.signal)).lines; }
      catch (error) { throw error instanceof OcrError ? error : invalid(); }
      // Layout found no blocks: without text lines the page is blank; otherwise it is read whole, as there is nothing to crop.
      if (!page.blocks.length) return lines.length ? whole() : { text: "", regions: [], truncated: false };
      try { return contentSchema.parse(await readBlocks({ ...page, blocks: page.blocks }, lines, read)); }
      catch (error) { throw error instanceof OcrError ? error : new OcrError("local-failed", failed); }
    },
    close() { native?.close(); quality?.close(); },
  };
}
