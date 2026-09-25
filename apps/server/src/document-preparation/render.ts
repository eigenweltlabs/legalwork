import { createCanvas, loadImage, DOMMatrix, Path2D } from "@napi-rs/canvas";
import { pdfAsset } from "./pdf-assets.js";
import type { OcrPage } from "../ocr/types.js";

export type RenderedPage = { image: OcrPage; nativeText: string };
export type RenderedDocument = { pageCount: number; page: (number: number, signal: AbortSignal) => Promise<RenderedPage>; close: () => Promise<void> };
class CanvasFactory {
  create(width: number, height: number) { const canvas = createCanvas(width, height); return { canvas, context: canvas.getContext("2d") }; }
  reset(target: { canvas: ReturnType<typeof createCanvas> }, width: number, height: number) { target.canvas.width = width; target.canvas.height = height; }
  destroy(target: { canvas: ReturnType<typeof createCanvas> }) { target.canvas.width = 0; target.canvas.height = 0; }
}
class BinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const directories: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };
    const directory = directories[kind];
    if (!directory) throw new Error("Unsupported PDF asset kind");
    return pdfAsset(`${directory}/${filename}`);
  }
}
let renderer: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
function loadRenderer() {
  renderer ??= (async () => {
    if (!Reflect.has(globalThis, "DOMMatrix")) Reflect.set(globalThis, "DOMMatrix", DOMMatrix);
    if (!Reflect.has(globalThis, "Path2D")) Reflect.set(globalThis, "Path2D", Path2D);
    // Static module paths let Bun embed the worker instead of loading a sibling file.
    Reflect.set(globalThis, "pdfjsWorker", await import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return renderer;
}
const MAX_PIXELS = 16_000_000;

/** Render at 144 dpi, bounded per page. PDF.js applies the page's crop and rotation. */
export async function openDocument(bytes: Uint8Array, kind: "pdf" | "image"): Promise<RenderedDocument> {
  if (kind === "image") {
    const source = await loadImage(Buffer.from(bytes));
    if (!source.width || !source.height || source.width * source.height > 40_000_000) throw new Error("Image exceeds 40 million pixels.");
    return {
      pageCount: 1,
      async page(number, signal) {
        signal.throwIfAborted();
        const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (source.width * source.height)));
        const width = Math.max(1, Math.floor(source.width * scale)), height = Math.max(1, Math.floor(source.height * scale));
        const canvas = createCanvas(width, height);
        canvas.getContext("2d").drawImage(source, 0, 0, width, height);
        return { nativeText: "", image: { pageNumber: number, mimeType: "image/png", width, height, data: new Uint8Array(await canvas.encode("png")) } };
      },
      async close() {},
    };
  }
  const { getDocument } = await loadRenderer();
  const loading = getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0, stopAtErrors: true,
    CanvasFactory, BinaryDataFactory, useWorkerFetch: false,
  });
  let pdf;
  try { pdf = await loading.promise; } catch (error) { await loading.destroy(); throw error; }
  if (pdf.numPages > 1000) { await loading.destroy(); throw new Error("Review documents must contain at most 1000 pages."); }
  return {
    pageCount: pdf.numPages,
    async page(number, signal) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const unit = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, Math.sqrt(MAX_PIXELS / (unit.width * unit.height))) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      // PDF.js types describe a browser canvas, but its supported Node renderer uses napi canvas.
      const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport });
      const abort = () => task.cancel();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) task.cancel();
        await task.promise;
        const content = await page.getTextContent();
        const nativeText = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        signal.throwIfAborted();
        return { nativeText, image: { pageNumber: number, mimeType: "image/png", width: canvas.width, height: canvas.height, data: new Uint8Array(await canvas.encode("png")) } };
      } finally { signal.removeEventListener("abort", abort); page.cleanup(); }
    },
    close: () => loading.destroy(),
  };
}
