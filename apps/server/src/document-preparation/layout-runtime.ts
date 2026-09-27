import { execFile } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { ocrResources } from "../ocr/runtime.js";
import { OcrError, OCR_MAX_PAGE_BYTES, pageSchema } from "../ocr/types.js";
import type { OcrPage } from "../ocr/types.js";
import type { LocalOcrRuntime } from "../ocr/local.js";
import { layoutModelReady } from "../ocr/models.js";

const model = "pp-doclayout-v3-onnx";
const revision = "46bbdf188bb0a772c08aed74882ce7e51a8f1ea6";
const sha256 = "45bf71750b00739a41fc209f132eb104a4d6b5bb29483c9078164d8b87cf28ba";
const boxSchema = z.strictObject({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine((box) => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001);
const detectionSchema = z.strictObject({
  model: z.literal(model),
  regions: z.array(z.strictObject({
    label: z.enum(["abstract", "algorithm", "aside_text", "chart", "content", "display_formula", "doc_title", "figure_title", "footer", "footer_image", "footnote", "formula_number", "header", "header_image", "image", "inline_formula", "number", "paragraph_title", "reference", "reference_content", "seal", "table", "text", "vertical_text", "vision_footnote"]),
    box: boxSchema,
    confidence: z.number().min(0).max(1),
    order: z.number().int().nonnegative(),
  })).max(1000),
});

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "HF_HOME", "HF_HUB_CACHE"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
}

function invoke(runtime: LocalOcrRuntime, signal: AbortSignal, input: string): Promise<string> {
  signal.throwIfAborted();
  const native = runtime.native;
  if (!native) throw new OcrError("runtime-unavailable", "Local document layout requires the bundled Node OCR runtime.");
  return new Promise((resolve, reject) => {
    const child = execFile(native.executable, [join(ocrResources, "layout-worker.cjs"), "--model-dir", runtime.modelDirectory], {
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
      signal, killSignal: "SIGKILL", env: { ...environment(), NODE_PATH: native.moduleDirectory, BUN_BE_BUN: "1" },
    }, (error, stdout) => {
      if (error) {
        if (signal.aborted) { reject(signal.reason); return; }
        reject(new OcrError(error.code === "ENOENT" ? "runtime-unavailable" : "local-failed",
          "Local document layout failed. Check the bundled OCR runtime and PP-DocLayoutV3 model."));
      } else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* Process exit and cancellation are handled above. */ });
    child.stdin?.end(input);
  });
}

export class LayoutRuntime {
  readonly fingerprint = `${model}@${revision}:sha256:${sha256}`;

  constructor(readonly runtime: LocalOcrRuntime) {}

  async ensure(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.runtime.native) throw new OcrError("runtime-unavailable", "Local document layout requires the bundled Node OCR runtime. Use the built-in OCR runtime on this server.");
    if (!await layoutModelReady(this.runtime.modelDirectory, signal))
      throw new OcrError("runtime-unavailable", "Download the document layout model in Settings → AI Providers, then retry.");
    signal.throwIfAborted();
  }

  async detect(page: OcrPage, signal: AbortSignal): Promise<z.infer<typeof detectionSchema>> {
    signal.throwIfAborted();
    if (page.data.byteLength > OCR_MAX_PAGE_BYTES) throw new OcrError("invalid-input", "Page exceeds the local layout input limit.");
    pageSchema.parse(page);
    await this.ensure(signal);
    const input = JSON.stringify({ image: Buffer.from(page.data).toString("base64"), width: page.width, height: page.height });
    const output = await invoke(this.runtime, signal, input);
    try { return detectionSchema.parse(JSON.parse(output)); }
    catch { throw new OcrError("invalid-response", "The local layout worker returned invalid regions."); }
  }
}
