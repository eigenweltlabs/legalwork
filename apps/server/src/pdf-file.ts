import { readSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { pdfAsset } from "./document-preparation/pdf-assets.js";
import type { RenderedDocument } from "./document-preparation/render.js";
import { ApiError } from "./errors.js";
import { PDF_IN_MEMORY_MAX_BYTES } from "./pdf-read-schema.js";

function heap(engine: WrappedPdfiumModule) {
  // Upstream exposes this Emscripten view at runtime but omits it from its types.
  const bytes: unknown = Reflect.get(engine.pdfium, "HEAPU8");
  if (!(bytes instanceof Uint8Array)) throw new Error("PDFium memory is unavailable.");
  return bytes;
}
type ReadBudget = { remaining: number; exceeded: boolean };
const processingError = () => new ApiError(400, "pdf_processing_size", "The selected PDF content exceeds the 64 MiB processing budget. Select fewer pages; if one page still exceeds it, optimize that page before reading.");

/** PDFium reads only requested blocks from an already authorized, open file.
 * Unlike PDF.js range loading, this does not allocate a source-sized buffer. */
export class PdfFile {
  private constructor(private readonly engine: WrappedPdfiumModule, private readonly document: number,
    private readonly access: number, private readonly callback: number, private readonly budget: ReadBudget, readonly pageCount: number) {}

  static async open(handle: FileHandle, size: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const engine = await init({ wasmBinary: pdfAsset("pdfium.wasm") });
    engine.PDFiumExt_Init();
    const runtime = engine.pdfium, access = runtime.wasmExports.malloc(12);
    const budget = { remaining: PDF_IN_MEMORY_MAX_BYTES, exceeded: false };
    const callback = runtime.addFunction((_param: number, position: number, destination: number, length: number) => {
      if (signal.aborted || position < 0 || position + length > size) return 0;
      // Stop immediately: reporting a failed block can make PDFium continue
      // with partial content or trap inside its parser.
      if (length > budget.remaining) { budget.exceeded = true; throw processingError(); }
      budget.remaining -= length;
      try {
        for (let offset = 0; offset < length;) {
          const count = readSync(handle.fd, heap(engine), destination + offset, Math.min(64 * 1024, length - offset), position + offset);
          if (!count) return 0;
          offset += count;
        }
        return 1;
      } catch { return 0; }
    }, "iiiii");
    runtime.setValue(access, size, "i32");
    runtime.setValue(access + 4, callback, "i32");
    runtime.setValue(access + 8, 0, "i32");
    let document = 0;
    try {
      document = engine.FPDF_LoadCustomDocument(access, "");
      if (budget.exceeded) throw new ApiError(400, "pdf_processing_size", "PDF structure exceeds the 64 MiB processing budget. Optimize or split this PDF before reading.");
      if (!document) throw new ApiError(400, "pdf_unreadable", "Could not read this PDF. Check that it is valid and not password-protected.");
      const pageCount = engine.FPDF_GetPageCount(document);
      if (pageCount > 1000) throw new ApiError(400, "pdf_page_count", "PDFs must contain at most 1000 pages. Split the source into smaller PDFs before reading.");
      return new PdfFile(engine, document, access, callback, budget, pageCount);
    } catch (error) {
      if (!budget.exceeded) {
        if (document) engine.FPDF_CloseDocument(document);
        runtime.wasmExports.free(access); engine.FPDF_DestroyLibrary();
      }
      runtime.removeFunction(callback);
      throw error;
    }
  }

  private beginPage() { this.budget.remaining = PDF_IN_MEMORY_MAX_BYTES; this.budget.exceeded = false; }
  private checkBudget() {
    if (this.budget.exceeded) throw processingError();
  }

  select(pages?: number[]) {
    const selected = [...new Set(pages ?? Array.from({ length: this.pageCount }, (_, i) => i + 1))].sort((a, b) => a - b);
    if (selected.some(page => !Number.isInteger(page) || page < 1 || page > this.pageCount))
      throw new ApiError(400, "pdf_page", `This PDF has ${this.pageCount} pages. Choose existing page numbers.`);
    return selected;
  }

  async text(selected: number[], signal: AbortSignal) {
    const pages: Array<{ page: number; text: string }> = [];
    let size = 0;
    for (const number of selected) {
      await setImmediate(); signal.throwIfAborted();
      this.beginPage();
      const page = this.engine.FPDF_LoadPage(this.document, number - 1);
      if (!page) { this.checkBudget(); throw new ApiError(400, "pdf_page", `Could not read PDF page ${number}.`); }
      let textPage = 0, buffer = 0;
      try {
        this.checkBudget();
        textPage = this.engine.FPDFText_LoadPage(page);
        this.checkBudget();
        if (!textPage) throw new ApiError(400, "pdf_page", `Could not extract text from PDF page ${number}.`);
        const count = this.engine.FPDFText_CountChars(textPage);
        if (count < 0 || size + count > 2_000_000) throw new ApiError(400, "pdf_text_size", "PDF text exceeds 2 million characters. Select fewer source pages with pages.");
        let text = "";
        if (count) {
          buffer = this.engine.pdfium.wasmExports.malloc((count + 1) * 2);
          const written = this.engine.FPDFText_GetText(textPage, 0, count, buffer);
          if (!written) throw new ApiError(400, "pdf_page", `Could not extract text from PDF page ${number}.`);
          text = this.engine.pdfium.UTF16ToString(buffer, Math.min(written, count + 1) * 2).replaceAll("\r\n", "\n");
        }
        this.checkBudget();
        size += text.length; pages.push({ page: number, text });
      } finally {
        if (!this.budget.exceeded) {
          if (buffer) this.engine.pdfium.wasmExports.free(buffer);
          if (textPage) this.engine.FPDFText_ClosePage(textPage);
          this.engine.FPDF_ClosePage(page);
        }
      }
    }
    return { pageCount: this.pageCount, pages };
  }

  renderer(): RenderedDocument {
    return {
      pageCount: this.pageCount,
      page: async (number, signal) => {
        await setImmediate(); signal.throwIfAborted();
        this.beginPage();
        const page = this.engine.FPDF_LoadPage(this.document, number - 1);
        if (!page) { this.checkBudget(); throw new ApiError(400, "pdf_page", `Could not render PDF page ${number}.`); }
        let bitmap = 0;
        try {
          this.checkBudget();
          const w = this.engine.FPDF_GetPageWidth(page), h = this.engine.FPDF_GetPageHeight(page);
          if (!(w > 0 && h > 0 && Number.isFinite(w * h))) throw new ApiError(400, "pdf_page", "Invalid PDF page dimensions.");
          const scale = Math.min(2, Math.sqrt(16_000_000 / (Math.ceil(w) * Math.ceil(h))));
          const width = Math.max(1, Math.floor(w * scale)), height = Math.max(1, Math.floor(h * scale));
          bitmap = this.engine.FPDFBitmap_Create(width, height, 1);
          if (!bitmap) throw new Error("Could not allocate a PDF page bitmap.");
          this.engine.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
          // Reverse-byte-order rendering produces RGBA for the canvas encoder.
          this.engine.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 1 | 0x10);
          this.checkBudget();
          const pointer = this.engine.FPDFBitmap_GetBuffer(bitmap);
          const pixels = new Uint8ClampedArray(heap(this.engine).slice(pointer, pointer + width * height * 4));
          const canvas = createCanvas(width, height);
          canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
          signal.throwIfAborted();
          return { nativeText: "", image: { pageNumber: number, mimeType: "image/png", width, height, data: new Uint8Array(await canvas.encode("png")) } };
        } finally { if (!this.budget.exceeded) { if (bitmap) this.engine.FPDFBitmap_Destroy(bitmap); this.engine.FPDF_ClosePage(page); } }
      },
      // The owning read closes the source after OCR and visual selection finish.
      async close() {},
    };
  }

  attachment(pages: number[], maximum: number, signal: AbortSignal) {
    signal.throwIfAborted();
    this.beginPage();
    const engine = this.engine, runtime = engine.pdfium;
    const subset = engine.FPDF_CreateNewDocument(), writer = runtime.wasmExports.malloc(8);
    const chunks: Buffer[] = []; let size = 0;
    const callback = runtime.addFunction((_writer: number, pointer: number, length: number) => {
      if (signal.aborted) return 0;
      size += length;
      if (size > maximum) return 0;
      chunks.push(Buffer.from(heap(engine).subarray(pointer, pointer + length)));
      return 1;
    }, "iiii");
    try {
      const imported = engine.FPDF_ImportPages(subset, this.document, pages.join(","), 0);
      this.checkBudget();
      if (!imported) throw new Error("Could not select PDF pages.");
      runtime.setValue(writer, 1, "i32"); runtime.setValue(writer + 4, callback, "i32");
      const saved = engine.FPDF_SaveAsCopy(subset, writer, 0);
      signal.throwIfAborted();
      if (size > maximum) return { too_large: true, pages, pdf_bytes: size };
      if (!saved) throw new Error("Could not create the selected PDF attachment.");
      return { too_large: false, pages, pdf_bytes: size, dataBase64: Buffer.concat(chunks).toString("base64") };
    } finally {
      if (!this.budget.exceeded) { engine.FPDF_CloseDocument(subset); runtime.wasmExports.free(writer); }
      runtime.removeFunction(callback);
    }
  }

  close() {
    // After an interrupted native call, discard this entire WASM instance;
    // calling destructors on its unfinished parser stack is unsafe.
    if (this.budget.exceeded) { this.engine.pdfium.removeFunction(this.callback); return; }
    this.engine.FPDF_CloseDocument(this.document);
    this.engine.pdfium.removeFunction(this.callback);
    this.engine.pdfium.wasmExports.free(this.access);
    this.engine.FPDF_DestroyLibrary();
  }
}
