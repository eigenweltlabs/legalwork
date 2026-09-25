import { z } from "zod";

export const OCR_MAX_PAGE_BYTES = 20 * 1024 * 1024;
export const OCR_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const OCR_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export const languageSchema = z.string().min(2).max(64).refine((value) => {
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
}, "Use a BCP 47 language tag, such as en, de, or zh-Hant");

export const pageSchema = z.strictObject({
  pageNumber: z.number().int().positive(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive().max(20000),
  height: z.number().int().positive().max(20000),
  data: z.instanceof(Uint8Array).refine((data) => data.byteLength > 0 && data.byteLength <= OCR_MAX_PAGE_BYTES),
}).refine((page) => page.width * page.height <= 40_000_000, "Page exceeds 40 million pixels");

const boxSchema = z.strictObject({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine((box) => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001);

export const contentSchema = z.strictObject({
  text: z.string().max(1_000_000),
  regions: z.array(z.strictObject({
    text: z.string().max(100_000),
    /** Normalized coordinates in the input image; top-left origin. */
    box: boxSchema,
    /** Engine score, NOT a calibrated probability of correctness. */
    confidence: z.number().min(0).max(1).optional(),
  })).max(20000),
  truncated: z.boolean().default(false),
});

export type OcrPage = z.infer<typeof pageSchema>;
export type OcrContent = z.infer<typeof contentSchema>;
export type OcrWarning = "recognition-errors-possible" | "fast-model-limitations" | "language-support-unverified" | "regions-unavailable" | "remote-processing" | "empty-text" | "output-truncated";
export type OcrEngineInfo = {
  id: string;
  label: string;
  execution: "local" | "remote";
  model: string;
  regions: boolean;
  /** null means unverified, never universal language support. */
  languages: readonly string[] | null;
  warnings: readonly OcrWarning[];
};
export type OcrContext = { languages: readonly string[]; signal: AbortSignal };
export interface OcrEngine {
  readonly info: OcrEngineInfo;
  recognize(page: OcrPage, context: OcrContext): Promise<OcrContent>;
}
export type OcrPageResult = OcrContent & {
  pageNumber: number;
  width: number;
  height: number;
  imageSha256: string;
  durationMs: number;
  warnings: OcrWarning[];
};
export type OcrResult = {
  sourceId: string;
  engine: OcrEngineInfo;
  languages: string[];
  warnings: OcrWarning[];
  pages: OcrPageResult[];
};
export type OcrProgress = {
  stage: "started" | "page-started" | "page-completed" | "completed";
  engine: OcrEngineInfo;
  warnings: readonly OcrWarning[];
  completedPages: number;
  totalPages: number;
  page?: OcrPageResult;
  pageNumber?: number;
};
export type OcrRequest = {
  sourceId: string;
  pages: readonly OcrPage[];
  languages: readonly string[];
  engineId?: string;
  signal?: AbortSignal;
  onProgress?: (event: OcrProgress) => void;
};

export class OcrError extends Error {
  constructor(
    readonly code: "invalid-input" | "unknown-engine" | "unsupported-language" | "runtime-unavailable" | "local-failed" | "missing-api-key" | "server-failed" | "invalid-response" | "cancelled" | "timeout",
    message: string,
  ) { super(message); this.name = "OcrError"; }
}
