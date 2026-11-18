import { expect, test } from "bun:test";
import { PDFDocument, rgb } from "pdf-lib";
import { PdfReader } from "./pdf-reader.js";
import { OcrService } from "./ocr/service.js";
import { OcrError } from "./ocr/types.js";
import type { OcrEngineInfo, OcrPage } from "./ocr/types.js";

async function document() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText("Short native text", { x: 10, y: 170, size: 12 });
  const mixed = pdf.addPage([200, 200]);
  mixed.drawText("Text plus logo", { x: 10, y: 170, size: 12 });
  mixed.drawRectangle({ x: 10, y: 20, width: 20, height: 20, color: rgb(1, 0, 0) });
  pdf.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(0, 0, 0) });
  return pdf.save();
}
function fixture(recognize: (page: OcrPage, signal: AbortSignal) => Promise<string> = async page => `Recognized page ${page.pageNumber}`, info: Pick<OcrEngineInfo, "execution" | "concurrentPages"> = { execution: "local" }) {
  const calls: number[] = [];
  let snapshots = 0, fingerprint = "settings-1";
  const reader = new PdfReader({ async serviceSnapshot() {
    snapshots++;
    return { fingerprint, service: new OcrService([{ info: { id: "test", label: "Test", model: "test", regions: false, languages: null, warnings: [], ...info },
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

test("default text reads report pages without embedded text without initializing OCR", async () => {
  const state = fixture(), bytes = await document();
  const result = await state.reader.read(bytes, {}, signal());
  expect(result.pages.map(page => page.extraction)).toEqual(["native", "native", "native"]);
  expect(result.pages[2]).toMatchObject({ text: "", embedded_text_chars: 0 });
  expect(result.complete).toBe(false);
  expect(state.snapshots()).toBe(0); expect(state.calls).toEqual([]);
});

test("explicit OCR reuses successful pages and invalidates them after settings change", async () => {
  const state = fixture(), bytes = await document(), options = { ocr: true, pages: [3] };
  const result = await state.reader.read(bytes, options, signal());
  expect(result.pages[0]).toMatchObject({ text: "Recognized page 3", embedded_text_chars: 0 });
  expect(result.complete).toBe(true);
  await state.reader.read(bytes, options, signal()); expect(state.calls).toEqual([3]);
  state.configure("settings-2");
  await state.reader.read(bytes, options, signal()); expect(state.calls).toEqual([3, 3]);
});

test("explicit OCR selects only requested pages and replaces overlapping native text", async () => {
  const state = fixture();
  const result = await state.reader.read(await document(), { ocr: true, pages: [2, 2] }, signal());
  expect(state.calls).toEqual([2]); expect(result.pages[0]).toMatchObject({ page: 2, text: "Recognized page 2", extraction: "ocr" });
  expect(result.pages[0]?.embedded_text_chars).toBeGreaterThan(0);
});

test("embedded text and OCR can be requested together without losing either source", async () => {
  const state = fixture();
  const result = await state.reader.read(await document(), { text: true, ocr: true, pages: [2] }, signal());
  expect(result.pages[0]).toMatchObject({ page: 2, text: "Recognized page 2", extraction: "ocr" });
  expect(result.pages[0]?.native_text?.trim()).toBe("Text plus logo");
  expect(state.calls).toEqual([2]);
});

test("explicit text-only reads do not initialize OCR for scanned pages", async () => {
  const state = fixture();
  const result = await state.reader.read(await document(), { text: true, pages: [3] }, signal());
  expect(result.pages).toEqual([{ page: 3, text: "", extraction: "native", embedded_text_chars: 0 }]);
  expect(result.complete).toBe(false);
  expect(state.snapshots()).toBe(0);
});

test("selected text and explicit OCR pages ignore oversized unrequested text", async () => {
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
  expect(explicit.pages[0]).toMatchObject({ page: 1, text: "Recognized page 1", extraction: "ocr" });
  const scanned = await state.reader.read(bytes, { pages: [2], ocr: true }, signal());
  expect(scanned.page_count).toBe(5);
  expect(scanned.pages).toEqual([{ page: 2, text: "Recognized page 2", extraction: "ocr", embedded_text_chars: 0 }]);
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
  await state.reader.read(bytes, { ocr: true, pages: [3] }, signal());
  const repeated = await state.reader.read(bytes, { ocr: true, pages: [3] }, signal());
  expect(repeated.pages[0]?.error).toContain("OCR was not repeated"); expect(state.calls).toEqual([3]);
  state.configure("settings-2");
  await state.reader.read(bytes, { ocr: true, pages: [3] }, signal()); expect(state.calls).toEqual([3, 3]);
});

test("invalid PDFs and nonexistent pages fail before OCR", async () => {
  const state = fixture();
  await expect(state.reader.read(new Uint8Array([1, 2, 3]), {}, signal())).rejects.toThrow("readable PDF");
  await expect(state.reader.read(await document(), { pages: [4] }, signal())).rejects.toThrow("3 pages");
  expect(state.calls).toEqual([]);
});

test("large scans are readable as text and oversized OCR explains how to select a batch", async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 101; i++) pdf.addPage([200, 200]);
  const bytes = await pdf.save(), state = fixture();
  const text = await state.reader.read(bytes, { text: true }, signal());
  expect(text.pages).toHaveLength(101); expect(text.complete).toBe(false);
  await expect(state.reader.read(bytes, { ocr: true }, signal())).rejects.toMatchObject({ code: "pdf_ocr_pages" });
  await expect(state.reader.read(bytes, { ocr: true }, signal())).rejects.toThrow("offset/limit only paginate returned text");
  expect(state.snapshots()).toBe(0);
  const selected = await state.reader.read(bytes, { ocr: true, pages: [101] }, signal());
  expect(selected.pages[0]).toMatchObject({ page: 101, text: "Recognized page 101", extraction: "ocr" });
  expect(state.calls).toEqual([101]);
});

test("cancellation interrupts OCR and does not become a successful partial read", async () => {
  const controller = new AbortController();
  const state = fixture(async () => { controller.abort(); return "cancelled"; });
  await expect(state.reader.read(await document(), { ocr: true, pages: [3] }, controller.signal)).rejects.toThrow();
  expect(state.calls).toEqual([3]);
});

test("remote pages overlap, retain source order and cache each completed page", async () => {
  const started = Promise.withResolvers<void>();
  const releases = new Map<number, () => void>();
  const state = fixture(async page => {
    await new Promise<void>(resolve => { releases.set(page.pageNumber, resolve); if (releases.size === 3) started.resolve(); });
    return `Recognized page ${page.pageNumber}`;
  }, { execution: "remote", concurrentPages: 3 });
  const bytes = await document(), operation = state.reader.read(bytes, { ocr: true }, signal());
  await started.promise;
  for (const page of [3, 1, 2]) releases.get(page)!();
  const result = await operation;
  expect(result.complete).toBe(true);
  expect(result.pages.map(page => page.text)).toEqual([1, 2, 3].map(page => `Recognized page ${page}`));
  await state.reader.read(bytes, { ocr: true }, signal());
  expect([...state.calls].sort((left, right) => left - right)).toEqual([1, 2, 3]);
});

test("page concurrency stays bounded, including local engines", async () => {
  for (const execution of ["local", "remote"] satisfies OcrEngineInfo["execution"][]) {
    let active = 0, peak = 0;
    const state = fixture(async page => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 15)); active--;
      return `Page ${page.pageNumber}`;
    }, { execution, concurrentPages: 2 });
    await state.reader.read(await document(), { ocr: true }, signal());
    expect(peak).toBe(execution === "local" ? 1 : 2);
  }
});

test("a failed parallel page preserves successful siblings", async () => {
  const state = fixture(async page => {
    if (page.pageNumber === 2) throw new Error("Synthetic failure");
    return `Page ${page.pageNumber}`;
  }, { execution: "remote", concurrentPages: 3 });
  const result = await state.reader.read(await document(), { ocr: true }, signal());
  expect(result.complete).toBe(false);
  expect(result.pages.map(page => page.error)).toEqual([undefined, "OCR processing failed.", undefined]);
  expect(result.pages[0].text).toBe("Page 1"); expect(result.pages[2].text).toBe("Page 3");
});

test("pending durable OCR can resume immediately without the ordinary failure cooldown", async () => {
  let pending = true;
  const state = fixture(async () => {
    if (pending) { pending = false; throw new OcrError("pending", "Read this unchanged page again to resume the saved job."); }
    return "Completed saved job";
  }, { execution: "remote", concurrentPages: 1 });
  const bytes = await document();
  expect((await state.reader.read(bytes, { ocr: true, pages: [1] }, signal())).complete).toBe(false);
  const resumed = await state.reader.read(bytes, { ocr: true, pages: [1] }, signal());
  expect(resumed.complete).toBe(true);
  expect(resumed.pages[0].text).toBe("Completed saved job");
  expect(state.calls).toEqual([1, 1]);
});

test("cancelling parallel OCR settles workers and keeps the reader reusable", async () => {
  const started = Promise.withResolvers<void>(), controller = new AbortController();
  let active = 0;
  const state = fixture(async (_page, requestSignal) => {
    if (++active === 3) started.resolve();
    await new Promise<void>((_resolve, reject) => requestSignal.addEventListener("abort", () => { active--; reject(requestSignal.reason); }, { once: true }));
    return "Never returned";
  }, { execution: "remote", concurrentPages: 3 });
  const operation = state.reader.read(await document(), { ocr: true }, controller.signal);
  const rejected = operation.catch(error => error);
  await started.promise; controller.abort();
  expect(await rejected).toBeInstanceOf(Error);
  expect(active).toBe(0);
  const text = await state.reader.read(await document(), { text: true, pages: [1] }, signal());
  expect(text.complete).toBe(true);
});
