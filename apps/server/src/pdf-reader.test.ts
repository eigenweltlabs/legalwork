import { expect, test } from "bun:test";
import { PDFDocument, rgb } from "pdf-lib";
import { PdfReader } from "./pdf-reader.js";
import { OcrService } from "./ocr/service.js";
import { OcrError } from "./ocr/types.js";
import type { OcrPage } from "./ocr/types.js";

async function document() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText("Short native text", { x: 10, y: 170, size: 12 });
  const mixed = pdf.addPage([200, 200]);
  mixed.drawText("Text plus logo", { x: 10, y: 170, size: 12 });
  mixed.drawRectangle({ x: 10, y: 20, width: 20, height: 20, color: rgb(1, 0, 0) });
  pdf.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(0, 0, 0) });
  return pdf.save();
}
function fixture(recognize: (page: OcrPage, signal: AbortSignal) => Promise<string> = async page => `Recognized page ${page.pageNumber}`) {
  const calls: number[] = [];
  let snapshots = 0, fingerprint = "settings-1";
  const reader = new PdfReader({ async serviceSnapshot() {
    snapshots++;
    return { fingerprint, service: new OcrService([{ info: { id: "test", label: "Test", model: "test", execution: "local", regions: false, languages: null, warnings: [] },
      async recognize(page, context) { calls.push(page.pageNumber); return { text: await recognize(page, context.signal), regions: [], truncated: false }; },
    }], "test") };
  } });
  return { reader, calls, snapshots: () => snapshots, configure: (value: string) => { fingerprint = value; } };
}
const signal = () => new AbortController().signal;

test("native PDF text, including short pages and drawings, does not initialize OCR", async () => {
  const state = fixture();
  const result = await state.reader.read(await document(), { pages: [1, 2] }, signal());
  expect(result.extraction).toBe("native"); expect(result.complete).toBe(true);
  expect(result.pages.map(page => page.text.trim())).toEqual(["Short native text", "Text plus logo"]);
  expect(state.snapshots()).toBe(0); expect(state.calls).toEqual([]);
});

test("automatic OCR reads only pages without embedded text and reuses successful pages", async () => {
  const state = fixture(), bytes = await document();
  const result = await state.reader.read(bytes, {}, signal());
  expect(result.pages.map(page => page.extraction)).toEqual(["native", "native", "ocr"]);
  expect(result.pages[2]?.text).toBe("Recognized page 3"); expect(result.complete).toBe(true);
  await state.reader.read(bytes, {}, signal()); expect(state.calls).toEqual([3]);
  state.configure("settings-2");
  await state.reader.read(bytes, {}, signal()); expect(state.calls).toEqual([3, 3]);
});

test("explicit OCR selects only requested pages and replaces overlapping native text", async () => {
  const state = fixture();
  const result = await state.reader.read(await document(), { ocr: true, pages: [2, 2] }, signal());
  expect(state.calls).toEqual([2]); expect(result.pages).toEqual([{ page: 2, text: "Recognized page 2", extraction: "ocr" }]);
});

test("selected native, automatic OCR and explicit OCR pages ignore oversized unrequested text", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText("Selected contract marker", { x: 10, y: 170, size: 12 });
  pdf.addPage([200, 200]);
  // Keep every character inside the page bounds so PDF.js does not clip the
  // fixture down to a small amount of text before the limit is exercised.
  for (let i = 0; i < 3; i++) pdf.addPage([200, 200]).drawText("x".repeat(700_000), { x: 10, y: 170, size: 0.0001 });
  const bytes = await pdf.save(), state = fixture();
  const native = await state.reader.read(bytes, { pages: [1] }, signal());
  expect(native.page_count).toBe(5);
  expect(native.pages.map(page => page.text.trim())).toEqual(["Selected contract marker"]);
  expect(state.snapshots()).toBe(0);
  const explicit = await state.reader.read(bytes, { pages: [1], ocr: true }, signal());
  expect(explicit.page_count).toBe(5);
  expect(explicit.pages).toEqual([{ page: 1, text: "Recognized page 1", extraction: "ocr" }]);
  const automatic = await state.reader.read(bytes, { pages: [2] }, signal());
  expect(automatic.page_count).toBe(5);
  expect(automatic.pages).toEqual([{ page: 2, text: "Recognized page 2", extraction: "ocr" }]);
  expect(state.calls).toEqual([1, 2]);
  await expect(state.reader.read(bytes, {}, signal())).rejects.toThrow("2 million characters");
});

test("OCR failure is reported as partial without retrying or discarding native text", async () => {
  const state = fixture(async () => { throw new OcrError("runtime-unavailable", "Install the OCR model."); });
  const result = await state.reader.read(await document(), { ocr: true, pages: [1] }, signal());
  expect(result.complete).toBe(false); expect(result.pages[0]?.text).toContain("Short native text");
  expect(result.pages[0]?.error).toBe("Install the OCR model."); expect(state.calls).toEqual([1]);
});

test("repeated failures do not immediately invoke OCR again for unchanged pages and settings", async () => {
  const state = fixture(async () => { throw new OcrError("runtime-unavailable", "Install the OCR model."); });
  const bytes = await document();
  await state.reader.read(bytes, { pages: [3] }, signal());
  const repeated = await state.reader.read(bytes, { pages: [3] }, signal());
  expect(repeated.pages[0]?.error).toContain("OCR was not repeated"); expect(state.calls).toEqual([3]);
  state.configure("settings-2");
  await state.reader.read(bytes, { pages: [3] }, signal()); expect(state.calls).toEqual([3, 3]);
});

test("invalid PDFs and nonexistent pages fail before OCR", async () => {
  const state = fixture();
  await expect(state.reader.read(new Uint8Array([1, 2, 3]), {}, signal())).rejects.toThrow("readable PDF");
  await expect(state.reader.read(await document(), { pages: [4] }, signal())).rejects.toThrow("3 pages");
  expect(state.calls).toEqual([]);
});

test("cancellation interrupts OCR and does not become a successful partial read", async () => {
  const controller = new AbortController();
  const state = fixture(async () => { controller.abort(); return "cancelled"; });
  await expect(state.reader.read(await document(), { pages: [3] }, controller.signal)).rejects.toThrow();
  expect(state.calls).toEqual([3]);
});
