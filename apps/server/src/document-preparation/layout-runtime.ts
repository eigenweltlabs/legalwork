import { join } from "node:path";
import { z } from "zod";
import { ocrResources } from "../ocr/runtime.js";
import { WorkerProcess } from "../ocr/worker-process.js";
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
    /** Bit-packed 200x200 region mask; the OCR worker derives PaddleX layout outlines from it. */
    mask: z.string().max(7000).optional(),
  })).max(1000),
});
type LayoutRegion = z.infer<typeof detectionSchema>["regions"][number];

/**
 * PaddleX LayoutAnalysisProcess (Apache-2.0) with the PaddleOCR-VL-1.6 layout config: whole-pixel
 * boxes, layout_nms, the large-image filter and "large" merge mode for titles, formulas and charts.
 */
export function postprocessLayout(input: LayoutRegion[], width: number, height: number): LayoutRegion[] {
  // numpy.round rounds halves to even.
  const round = (value: number) => Math.abs(value % 1) === .5 ? 2 * Math.round(value / 2) : Math.round(value);
  const regions = input.flatMap(region => {
    const { x, y, width: w, height: h } = region.box;
    const [x0, y0, x1, y1] = [x * width, y * height, (x + w) * width, (y + h) * height].map(round);
    return x1! > x0! && y1! > y0! ? [{ ...region, box: { x: x0! / width, y: y0! / height, width: (x1! - x0!) / width, height: (y1! - y0!) / height } }] : [];
  });
  const px = ({ box }: LayoutRegion) => [box.x * width, box.y * height, (box.x + box.width) * width, (box.y + box.height) * height] as const;
  const area = (region: LayoutRegion) => { const [x0, y0, x1, y1] = px(region); return (x1 - x0) * (y1 - y0); };
  const intersection = (a: LayoutRegion, b: LayoutRegion, pad: number) => {
    const [ax0, ay0, ax1, ay1] = px(a), [bx0, by0, bx1, by1] = px(b);
    return Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0) + pad) * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0) + pad);
  };
  const iou = (a: LayoutRegion, b: LayoutRegion) => {
    const [ax0, ay0, ax1, ay1] = px(a), [bx0, by0, bx1, by1] = px(b), shared = intersection(a, b, 1);
    return shared / ((ax1 - ax0 + 1) * (ay1 - ay0 + 1) + (bx1 - bx0 + 1) * (by1 - by0 + 1) - shared);
  };
  const kept: LayoutRegion[] = [];
  for (const region of [...regions].sort((a, b) => b.confidence - a.confidence))
    if (kept.every(other => iou(other, region) < (other.label === region.label ? 0.6 : 0.98))) kept.push(region);
  const limit = (width > height ? 0.82 : 0.93) * width * height;
  const sized = kept.length > 1 ? kept.filter(region => region.label !== "image" || area(region) <= limit) : kept;
  const boxes = sized.length ? sized : kept;
  const large = ["chart", "display_formula", "doc_title", "inline_formula", "paragraph_title"];
  const contained = (inner: LayoutRegion, outer: LayoutRegion) => area(inner) > 0 && intersection(inner, outer, 0) / area(inner) >= 0.9;
  return boxes.filter(region => !boxes.some(other => other !== region && large.includes(other.label) && contained(region, other)))
    .sort((a, b) => a.order - b.order);
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "HF_HOME", "HF_HUB_CACHE"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
}

export class LayoutRuntime {
  readonly fingerprint = `${model}@${revision}:sha256:${sha256}:paddle-postprocess-2`;

  // Loaded once and reused for every page until closed or idle.
  private worker?: WorkerProcess;

  constructor(readonly runtime: LocalOcrRuntime) {}

  close() { this.worker?.close(); }

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
    const native = this.runtime.native;
    if (!native) throw new OcrError("runtime-unavailable", "Local document layout requires the bundled Node OCR runtime.");
    this.worker ??= new WorkerProcess({
      executable: native.executable, args: [join(ocrResources, "layout-worker.cjs"), "--model-dir", this.runtime.modelDirectory],
      env: { ...environment(), NODE_PATH: native.moduleDirectory, BUN_BE_BUN: "1" }, maxReply: 8 * 1024 * 1024,
      unavailable: "Local document layout requires the bundled Node OCR runtime.",
      failed: "Local document layout failed. Check the bundled OCR runtime and PP-DocLayoutV3 model.",
    });
    const output = await this.worker.request({ image: Buffer.from(page.data).toString("base64"), width: page.width, height: page.height },
      AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
    let detection: z.infer<typeof detectionSchema>;
    try { detection = detectionSchema.parse(output); }
    catch { throw new OcrError("invalid-response", "The local layout worker returned invalid regions."); }
    return { ...detection, regions: postprocessLayout(detection.regions, page.width, page.height) };
  }
}
