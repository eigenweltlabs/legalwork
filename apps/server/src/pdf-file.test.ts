import { expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PdfReader } from "./pdf-reader.js";
import { PDF_MAX_BYTES } from "./pdf-read-schema.js";
import { spawnSync } from "node:child_process";
import { OcrService } from "./ocr/service.js";

import { largePdf } from "./pdf-file.test-support.js";

test("1 GiB PDFs use disk-backed text, selected visual pages and OCR with bounded memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-large-pdf-test-"));
  const path = join(directory, "contract.pdf");
  let calls = 0;
  const reader = new PdfReader({ async serviceSnapshot() {
    return { fingerprint: "test", service: new OcrService([{
      info: { id: "test", label: "Test", model: "test", execution: "local", regions: false, languages: null, warnings: [] },
      async recognize(page) {
        calls++; expect(page.data.subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(page.width).toBe(400); expect(page.height).toBe(400);
        return { text: "Recognized large-source page", regions: [], truncated: false };
      },
    }], "test") };
  } });
  const signal = new AbortController().signal;
  try {
    await largePdf(path, PDF_MAX_BYTES);
    const native = await reader.readFile(path, { pages: [1] }, signal);
    expect(native.page_count).toBe(2); expect(native.pages[0]?.text).toContain("Large source contract marker");
    expect(calls).toBe(0);
    const attached = await reader.readFile(path, { pages: [1], attach: true }, signal);
    if (!("visual" in attached)) throw new Error("Missing PDF attachment");
    expect(attached.visual?.too_large).toBe(false);
    const selected = await PDFDocument.load(Buffer.from(attached.visual?.dataBase64 ?? "", "base64"));
    expect(selected.getPageCount()).toBe(1);
    const recognized = await reader.readFile(path, { pages: [2], ocr: true }, signal);
    expect(recognized.complete).toBe(true); expect(recognized.pages[0]?.text).toBe("Recognized large-source page");
    expect(calls).toBe(1);
    const measured = spawnSync(process.execPath, ["-e", `
      import { PdfReader } from ${JSON.stringify(new URL("./pdf-reader.ts", import.meta.url).href)};
      const reader = new PdfReader({ serviceSnapshot() { throw new Error("OCR not requested"); } });
      const result = await reader.readFile(process.argv[1], { pages: [1] }, new AbortController().signal);
      console.log(JSON.stringify({ text: result.pages[0].text, peakKiB: process.resourceUsage().maxRSS }));
    `, path], { encoding: "utf8", timeout: 30_000 });
    expect(measured.status).toBe(0);
    const measurement = JSON.parse(measured.stdout);
    expect(measurement.text).toContain("Large source contract marker");
    // A full 1 GiB source buffer cannot fit under this peak-RSS ceiling.
    expect(measurement.peakKiB).toBeLessThan(512 * 1024);
    await expect(reader.readFile(path, { pages: [3] }, signal)).rejects.toThrow("2 pages");
    const handle = await open(path, "r+"); try { await handle.truncate(PDF_MAX_BYTES + 1); } finally { await handle.close(); }
    await expect(reader.readFile(path, {}, signal)).rejects.toThrow("at most 1 GiB");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("streamed small files retain embedded text and cancellation rejects the read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-file-pdf-test-")), path = join(directory, "small.pdf");
  const reader = new PdfReader({ async serviceSnapshot() { throw new Error("Must not initialize OCR"); } });
  try {
    const pdf = await PDFDocument.create(); pdf.addPage().drawText("Small contract marker"); await writeFile(path, await pdf.save());
    expect((await reader.readFile(path, {}, new AbortController().signal)).pages[0]?.text).toContain("Small contract marker");
    const controller = new AbortController(); controller.abort();
    await expect(reader.readFile(path, {}, controller.signal)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("oversized individual page content fails explicitly instead of being reported as blank", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-pdf-budget-test-")), path = join(directory, "large-page.pdf");
  const reader = new PdfReader({ async serviceSnapshot() { throw new Error("OCR not requested"); } });
  try {
    await largePdf(path, 80 * 1024 * 1024, true);
    await expect(reader.readFile(path, { pages: [2] }, new AbortController().signal)).rejects.toMatchObject({ code: "pdf_processing_size" });
    const first = await reader.readFile(path, { pages: [1] }, new AbortController().signal);
    expect(first.pages[0]?.text).toContain("Large source contract marker");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
