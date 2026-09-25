import { createHash } from "node:crypto";
import { z } from "zod";
import { contentSchema, languageSchema, OCR_MAX_DOCUMENT_BYTES, OcrError, pageSchema } from "./types.js";
import type { OcrEngine, OcrEngineInfo, OcrPageResult, OcrRequest, OcrResult, OcrWarning } from "./types.js";

const requestSchema = z.object({
  sourceId: z.string().trim().min(1).max(1024),
  pages: z.array(pageSchema).min(1).max(100),
  languages: z.array(languageSchema).max(32),
  engineId: z.string().min(1).optional(),
}).superRefine((request, context) => {
  if (new Set(request.pages.map((page) => page.pageNumber)).size !== request.pages.length)
    context.addIssue({ code: "custom", message: "Duplicate page numbers" });
  if (request.pages.reduce((sum, page) => sum + page.data.byteLength, 0) > OCR_MAX_DOCUMENT_BYTES)
    context.addIssue({ code: "custom", message: "Document images exceed 64 MiB; submit smaller batches" });
});

function copyInfo(info: OcrEngineInfo): OcrEngineInfo {
  return { ...info, languages: info.languages === null ? null : [...info.languages], warnings: [...info.warnings] };
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // The operation may have aborted synchronously while starting. Consume its rejection too.
    operation.catch(() => undefined);
    return Promise.reject(new OcrError("cancelled", "OCR was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new OcrError("cancelled", "OCR was cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Explicit engine selection only. Never detects handwriting, skips pages, or falls back to a server. */
export class OcrService {
  private readonly engines = new Map<string, OcrEngine>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(engines: readonly OcrEngine[], readonly defaultEngineId = "local-fast", private readonly pageTimeoutMs = 120_000) {
    if (!Number.isInteger(pageTimeoutMs) || pageTimeoutMs < 1 || pageTimeoutMs > 600_000)
      throw new OcrError("invalid-input", "Page timeout must be between 1 and 600000 milliseconds.");
    for (const engine of engines) {
      if (this.engines.has(engine.info.id)) throw new OcrError("invalid-input", "Duplicate OCR engine ID.");
      this.engines.set(engine.info.id, engine);
    }
    if (!this.engines.has(defaultEngineId)) throw new OcrError("unknown-engine", "The default OCR engine is not registered.");
  }

  listEngines(): OcrEngineInfo[] { return [...this.engines.values()].map((engine) => copyInfo(engine.info)); }

  /** Serialize jobs per service instance to bound local model memory. Callers own persistence and file authorization. */
  async extract(request: OcrRequest): Promise<OcrResult> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) throw new OcrError("invalid-input", "Invalid OCR pages, languages, or source identifier.");
    const engine = this.engines.get(parsed.data.engineId ?? this.defaultEngineId);
    if (!engine) throw new OcrError("unknown-engine", "The selected OCR engine is not registered.");
    const languages = Intl.getCanonicalLocales(parsed.data.languages);
    if (engine.info.languages !== null && languages.some((language) => !engine.info.languages?.some((supported) =>
      language.toLowerCase() === supported.toLowerCase() || language.toLowerCase().startsWith(`${supported.toLowerCase()}-`))))
      throw new OcrError("unsupported-language", "The selected OCR engine does not declare support for every requested language. Select another engine.");

    const run = this.pending.catch(() => undefined).then(async () => {
      if (request.signal?.aborted) throw new OcrError("cancelled", "OCR was cancelled.");
      const info = copyInfo(engine.info);
      const warnings: OcrWarning[] = [...new Set<OcrWarning>([
        "recognition-errors-possible", ...info.warnings,
        ...(info.languages === null ? ["language-support-unverified"] satisfies OcrWarning[] : []),
        ...(!info.regions ? ["regions-unavailable"] satisfies OcrWarning[] : []),
        ...(info.execution === "remote" ? ["remote-processing"] satisfies OcrWarning[] : []),
      ])];
      const pages: OcrPageResult[] = [];
      const notify = (stage: "started" | "page-started" | "page-completed" | "completed", page?: OcrPageResult, pageNumber?: number) =>
        request.onProgress?.({ stage, engine: copyInfo(info), warnings: [...warnings], completedPages: pages.length, totalPages: parsed.data.pages.length, page, pageNumber });
      notify("started");
      for (const page of parsed.data.pages) {
        if (request.signal?.aborted) throw new OcrError("cancelled", "OCR was cancelled.");
        notify("page-started", undefined, page.pageNumber);
        const timeout = AbortSignal.timeout(this.pageTimeoutMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        const start = performance.now();
        try {
          signal.throwIfAborted();
          const content = contentSchema.safeParse(await abortable(engine.recognize(page, { languages, signal }), signal));
          signal.throwIfAborted();
          if (!content.success) throw new OcrError("invalid-response", "The OCR engine returned invalid text or coordinates.");
          const pageWarnings = [...warnings];
          if (!content.data.text.trim()) pageWarnings.push("empty-text");
          if (content.data.truncated) pageWarnings.push("output-truncated");
          const result: OcrPageResult = {
            ...content.data, pageNumber: page.pageNumber, width: page.width, height: page.height,
            imageSha256: createHash("sha256").update(page.data).digest("hex"),
            durationMs: performance.now() - start, warnings: pageWarnings,
          };
          pages.push(result);
          notify("page-completed", result, page.pageNumber);
        } catch (error) {
          if (request.signal?.aborted) throw new OcrError("cancelled", "OCR was cancelled.");
          if (timeout.aborted) throw new OcrError("timeout", "The OCR page exceeded its time limit.");
          if (error instanceof OcrError) throw error;
          throw new OcrError("invalid-response", "OCR processing failed.");
        }
      }
      notify("completed");
      return { sourceId: parsed.data.sourceId, engine: info, languages, warnings, pages };
    });
    this.pending = run;
    return abortable(run, request.signal);
  }
}
