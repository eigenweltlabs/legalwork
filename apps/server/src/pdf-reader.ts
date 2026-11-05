import { createHash } from "node:crypto";
import { extractPdfText, openDocument } from "./document-preparation/render.js";
import { ApiError } from "./errors.js";
import type { OcrManager } from "./ocr/manager.js";
import type { OcrService } from "./ocr/service.js";
import { PDF_MAX_BYTES, pdfReadOptions, type PdfTextResult } from "./pdf-read-schema.js";
import type { z } from "zod";

/** Reading uses the configured OCR engine, without review layout analysis or implicit retries. */
export class PdfReader {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, string>();
  private readonly failures = new Map<string, { error: string; until: number }>();
  private cacheBytes = 0;
  constructor(private readonly ocr: Pick<OcrManager, "serviceSnapshot">) {}

  private remember(key: string, text: string) {
    const size = Buffer.byteLength(text);
    if (size > 8 * 1024 * 1024) return;
    while (this.cache.size >= 1000 || this.cacheBytes + size > 32 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheBytes -= Buffer.byteLength(this.cache.get(oldest)!);
      this.cache.delete(oldest);
    }
    this.cache.set(key, text); this.cacheBytes += size;
  }

  async read(bytes: Uint8Array, options: z.infer<typeof pdfReadOptions>, signal: AbortSignal): Promise<PdfTextResult> {
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > PDF_MAX_BYTES || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-")))
      throw new ApiError(400, "pdf_input", "Provide a readable PDF of at most 64 MiB.");
    const source_hash = createHash("sha256").update(bytes).digest("hex");
    const native = await extractPdfText(bytes, signal, options.pages);
    const pages: PdfTextResult["pages"] = native.pages.map(page => ({ ...page, extraction: "native" }));
    const required = pages.filter(page => options.ocr === true || !page.text.trim());
    if (!required.length) return { source_hash, page_count: native.pageCount, extraction: "native", complete: true, pages };
    if (required.length > 100) throw new ApiError(400, "pdf_ocr_pages", "Read at most 100 OCR pages at a time using pages. Embedded text does not require OCR.");
    // Serialize OCR across reads. A cancelled request must not release the slot
    // while an earlier operation still owns the model process.
    const operation = this.pending.catch(() => undefined).then(async () => {
      signal.throwIfAborted();
      let service: OcrService | undefined;
      let document: Awaited<ReturnType<typeof openDocument>> | undefined;
      try {
        const snapshot = await this.ocr.serviceSnapshot();
        service = snapshot.service;
        for (const page of required) {
          signal.throwIfAborted();
          const key = `${source_hash}:${snapshot.fingerprint}:${page.page}`;
          const cached = this.cache.get(key);
          if (cached !== undefined) { page.text = cached; page.extraction = "ocr"; continue; }
          const failed = this.failures.get(key);
          if (failed && failed.until > Date.now()) {
            page.error = `${failed.error} OCR was not repeated for this unchanged page and configuration. Resolve the problem or wait one minute before retrying.`;
            continue;
          }
          this.failures.delete(key);
          try {
            document ??= await openDocument(bytes, "pdf");
            const rendered = await document.page(page.page, signal);
            const result = await service.extract({ sourceId: source_hash, pages: [rendered.image], languages: [], signal });
            const recognized = result.pages[0];
            if (!recognized?.text.trim() || recognized.truncated) throw new Error(recognized?.truncated ? "OCR output was truncated." : "OCR returned no readable text.");
            page.text = recognized.text; page.extraction = "ocr";
            this.remember(key, page.text);
          } catch (error) {
            signal.throwIfAborted();
            page.error = error instanceof Error ? error.message : "Could not recognize this page.";
            if (this.failures.size >= 1000) this.failures.delete(this.failures.keys().next().value!);
            this.failures.set(key, { error: page.error, until: Date.now() + 60000 });
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        for (const page of required) page.error ??= error instanceof Error ? error.message : "OCR is unavailable. Check Settings → AI Providers.";
      } finally { try { await document?.close(); } finally { service?.close(); } }
    });
    this.pending = operation;
    await operation;
    signal.throwIfAborted();
    if (pages.reduce((sum, page) => sum + page.text.length, 0) > 2_000_000)
      throw new ApiError(400, "pdf_text_size", "Extracted text exceeds 2 million characters. Read fewer pages.");
    return { source_hash, page_count: native.pageCount, extraction: "ocr", complete: pages.every(page => !page.error), pages };
  }
}
