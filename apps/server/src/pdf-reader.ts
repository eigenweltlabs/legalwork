import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extractPdfText, openDocument } from "./document-preparation/render.js";
import { ApiError } from "./errors.js";
import type { OcrManager } from "./ocr/manager.js";
import type { OcrService } from "./ocr/service.js";
import { PDF_MAX_BYTES, PDF_IN_MEMORY_MAX_BYTES, PDF_ATTACHMENT_MAX_BYTES, pdfReadOptions, type PdfTextResult } from "./pdf-read-schema.js";
import { PdfFile } from "./pdf-file.js";
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
    if (!bytes.length || bytes.length >= PDF_IN_MEMORY_MAX_BYTES || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-")))
      throw new ApiError(400, "pdf_input", "Provide a readable PDF. PDFs of 64 MiB or more must use the streamed file reader (maximum 1 GiB).");
    const source_hash = createHash("sha256").update(bytes).digest("hex");
    const native = await extractPdfText(bytes, signal, options.pages);
    return this.recognize(source_hash, native, () => openDocument(bytes, "pdf"), options, signal);
  }

  async readFile(path: string, options: z.infer<typeof pdfReadOptions>, signal: AbortSignal, sourceHash?: string) {
    signal.throwIfAborted();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let pdf: PdfFile | undefined;
    try {
      const info = await handle.stat(), header = Buffer.alloc(1024);
      if (!info.isFile() || !info.size || info.size > PDF_MAX_BYTES) throw new ApiError(400, "pdf_input", "Provide a readable PDF of at most 1 GiB.");
      const start = await handle.read(header, 0, header.length, 0);
      if (!header.subarray(0, start.bytesRead).includes(Buffer.from("%PDF-"))) throw new ApiError(400, "pdf_input", "Provide a readable PDF.");
      if (!sourceHash) {
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, signal })) hash.update(chunk);
        sourceHash = hash.digest("hex");
      }
      if (info.size >= PDF_IN_MEMORY_MAX_BYTES || options.attach) pdf = await PdfFile.open(handle, info.size, signal);
      const selected = pdf?.select(options.pages);
      // Bound candidate output before encoding. The plugin counts the complete
      // serialized file envelope against the 2 MB model limit before attaching.
      const maximum = Math.floor(PDF_ATTACHMENT_MAX_BYTES / 4) * 3;
      const visual = options.attach && pdf && selected
        ? options.pages ? pdf.attachment(selected, maximum, signal)
          : { too_large: info.size > maximum, pages: selected, pdf_bytes: info.size,
            ...(info.size <= maximum ? { dataBase64: (await handle.readFile({ signal })).toString("base64") } : {}) }
        : undefined;
      const text = options.text ?? (!options.attach && !options.ocr);
      if ((visual?.too_large || !text && !options.ocr) && pdf) return { source_hash: sourceHash, page_count: pdf.pageCount,
        extraction: "native", complete: true, pages: [], visual } satisfies PdfTextResult & { visual: typeof visual };
      if (!pdf) return await this.read(await handle.readFile({ signal }), options, signal);
      const native = await pdf.text(selected!, signal), document = pdf;
      const result = await this.recognize(sourceHash, native, async () => document.renderer(), options, signal);
      return { ...result, visual };
    } finally { try { pdf?.close(); } finally { await handle.close(); } }
  }

  private async recognize(source_hash: string, native: Awaited<ReturnType<typeof extractPdfText>>,
    render: () => ReturnType<typeof openDocument>, options: z.infer<typeof pdfReadOptions>, signal: AbortSignal): Promise<PdfTextResult> {
    const pages: PdfTextResult["pages"] = native.pages.map(page => ({ ...page, embedded_text_chars: page.text.trim().length, extraction: "native" }));
    const required = options.ocr === true ? pages : [];
    if (options.ocr === true && options.text === true) for (const page of required) page.native_text = page.text;
    if (!required.length) return { source_hash, page_count: native.pageCount, extraction: "native", complete: pages.every(page => page.embedded_text_chars > 0), pages };
    if (required.length > 100) throw new ApiError(400, "pdf_ocr_pages", "OCR was not started: at most 100 pages can be recognized per call. Select fewer source pages with pages, or use text=true without ocr for embedded text. offset/limit only paginate returned text and do not reduce OCR work.");
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
            document ??= await render();
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
    if (pages.reduce((sum, page) => sum + page.text.length + (page.native_text?.length ?? 0), 0) > 2_000_000)
      throw new ApiError(400, "pdf_text_size", "Extracted text exceeds 2 million characters. Select fewer source pages with pages. offset/limit only paginate returned text and do not reduce extraction work.");
    return { source_hash, page_count: native.pageCount, extraction: "ocr", complete: pages.every(page => !page.error), pages };
  }
}
