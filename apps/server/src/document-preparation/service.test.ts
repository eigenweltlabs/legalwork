import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { OcrManager } from "../ocr/manager.js";
import { OcrService } from "../ocr/service.js";
import { OcrError, type OcrEngine } from "../ocr/types.js";
import { DocumentPreparation, documentPath, preparedSchema } from "./service.js";
import type { DocumentLayout } from "./structure.js";
import { openDocument } from "./render.js";

const layout: DocumentLayout = { fingerprint: "test-layout-1", async detect() {
  return { model: "test-layout", regions: [{ label: "text", box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1, order: 0 }] };
} };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-preparation-")); roots.push(root);
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText("Native agreement: 30 days", { x: 20, y: 350, size: 12 });
  const scan = await pdf.embedPng(await readFile(new URL("../ocr/fixtures/bilingual.png", import.meta.url)));
  const page = pdf.addPage([500, 130]); page.drawImage(scan, { x: 0, y: 0, width: 500, height: 130 }); page.setRotation(degrees(90));
  await writeFile(join(root, "contract.pdf"), await pdf.save());
  return root;
}
async function done(service: DocumentPreparation, root: string, id: string) {
  for (let index = 0; index < 300; index++) {
    const result = await service.status(root, id);
    if (!["queued", "running"].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Preparation did not finish");
}
const info: OcrEngine["info"] = { id: "test", label: "Test OCR", execution: "local", model: "multilingual", languages: null, regions: true, warnings: [] };
const content = { text: "Visual addition: 60 days", regions: [{ text: "Visual addition: 60 days", box: { x: 0.1, y: 0.2, width: 0.7, height: 0.1 } }], truncated: false };

test("renders native and rotated scanned pages, OCRs both, pins model and caches by content/configuration", async () => {
  const root = await fixture();
  const calls: number[] = []; let fingerprint = "model-A";
  const service = new DocumentPreparation(new OcrManager(join(root, "ocr")), { layout, snapshot: async () => ({ fingerprint, service: new OcrService([{ info, async recognize(page, context) {
    calls.push(page.pageNumber); expect(context.languages).toEqual([]); expect(page.data.length).toBeGreaterThan(100); return content;
  } }], "test") }) });
  const first = await service.start(root, { files: ["contract.pdf"] }); fingerprint = "model-B";
  const finished = await done(service, root, first.id);
  expect(finished.status).toBe("complete"); expect(calls).toEqual([1, 2]);
  const doc = preparedSchema.parse(JSON.parse(await readFile(join(root, finished.documents[0]!.preparationPath!), "utf8")));
  expect(doc.pages[0]!.nativeText).toContain("Native agreement"); expect(doc.pages[0]!.ocr?.text).toContain("60 days");
  expect(doc.pages[1]!.nativeText).toBe(""); expect(doc.pages[1]!.height).toBeGreaterThan(doc.pages[1]!.width);
  fingerprint = "model-A";
  await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id); expect(calls).toEqual([1, 2]);
  fingerprint = "model-B";
  await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id); expect(calls).toEqual([1, 2, 1, 2]);
  await done(service, root, (await service.start(root, { files: ["contract.pdf"], force: true })).id); expect(calls.length).toBe(6);
  // A different source hash must never reuse old evidence.
  const replacement = await PDFDocument.create(); replacement.addPage([200, 200]).drawText("New version");
  await writeFile(join(root, "contract.pdf"), await replacement.save());
  await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id); expect(calls.length).toBe(7);
}, 15_000);

test("failed pages remain visible, keep native text, and retry without rerunning successful pages", async () => {
  const root = await fixture(); let fail = true; const calls: number[] = [];
  const service = new DocumentPreparation(new OcrManager(join(root, "ocr")), { layout, snapshot: async () => ({ fingerprint: "A", service: new OcrService([{ info, async recognize(page) {
    calls.push(page.pageNumber); if (page.pageNumber === 1 && fail) throw new Error("provider failure"); return content;
  } }], "test") }) });
  const result = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  expect(result.status).toBe("needs-review");
  const doc = preparedSchema.parse(JSON.parse(await readFile(join(root, result.documents[0]!.preparationPath!), "utf8")));
  expect(doc.pages[0]!.status).toBe("error"); expect(doc.pages[0]!.nativeText).toContain("Native agreement"); expect(doc.pages[1]!.status).toBe("complete");
  fail = false;
  const retry = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  expect(retry.status).toBe("complete"); expect(calls).toEqual([1, 2, 1]);
}, 10_000);

test("cancelled runs retain completed pages and cannot be read or cancelled from another workspace", async () => {
  const root = await fixture(), other = await fixture(); let calls = 0;
  let entered!: () => void; const second = new Promise<void>(resolve => { entered = resolve; });
  const service = new DocumentPreparation(new OcrManager(join(root, "ocr")), { layout, snapshot: async () => ({ fingerprint: "A", service: new OcrService([{ info, async recognize(page, context) {
    calls++; if (page.pageNumber === 2 && calls === 2) { entered(); await new Promise<void>((resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); } return content;
  } }], "test") }) });
  const run = await service.start(root, { files: ["contract.pdf"] });
  await second;
  await expect(service.status(other, run.id)).rejects.toThrow("not found");
  await expect(service.cancel(other, run.id)).rejects.toThrow("not found");
  await service.cancel(root, run.id);
  const retry = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  expect(retry.status).toBe("complete"); expect(calls).toBe(3);
}, 10_000);

test("bounds workspace sources and output paths, rejects missing model and supports source images", async () => {
  const root = await fixture(), other = await fixture();
  await symlink(join(other, "contract.pdf"), join(root, "outside.pdf"));
  await expect(documentPath(root, "outside.pdf")).rejects.toThrow("outside");
  await expect(documentPath(root, join(other, "contract.pdf"))).rejects.toThrow("outside");
  const manager = new OcrManager(join(root, "ocr"));
  await expect(new DocumentPreparation(manager).start(root, { files: ["contract.pdf"] })).rejects.toThrow("Download");
  const image = await openDocument(new Uint8Array(await readFile(new URL("../ocr/fixtures/bilingual.png", import.meta.url))), "image");
  expect(image.pageCount).toBe(1); expect((await image.page(1, new AbortController().signal)).nativeText).toBe(""); await image.close();
  await symlink(other, join(root, ".opencode"));
  const service = new DocumentPreparation(manager, { layout, snapshot: async () => ({ fingerprint: "A", service: new OcrService([{ info, async recognize() { return content; } }], "test") }) });
  const result = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  expect(result.documents[0]!.error).toContain("outside");
}, 10_000);

test("layout failure preserves OCR and retry recovers without another OCR request", async () => {
  const root = await fixture(); let fail = true, calls = 0, layoutCalls = 0;
  const service = new DocumentPreparation(new OcrManager(join(root, "ocr")), {
    layout: { fingerprint: "retry-layout", async detect(page, signal) { layoutCalls++; if (fail) throw new OcrError("runtime-unavailable", "offline"); return layout.detect(page, signal); } },
    snapshot: async () => ({ fingerprint: "ocr", service: new OcrService([{ info, async recognize() { calls++; return content; } }], "test") }),
  });
  const first = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  const read = async (path: string) => preparedSchema.parse(JSON.parse(await readFile(join(root, path), "utf8")));
  const partial = await read(first.documents[0]!.preparationPath!);
  expect(first.status).toBe("needs-review"); expect(layoutCalls).toBe(1);
  expect(partial.pages.every(page => page.ocr?.text === content.text && page.structure?.status === "unavailable")).toBe(true);
  fail = false;
  const second = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  expect(second.status).toBe("complete"); expect(calls).toBe(2);
  expect((await read(second.documents[0]!.preparationPath!)).pages.every(page => page.structure?.regions[0]?.text === content.text)).toBe(true);
}, 10_000);

test("shared prepared-document reader rejects changed sources and escaped cache paths", async () => {
  const { readPreparedDocument } = await import("./read.js");
  const root = await fixture();
  const service = new DocumentPreparation(new OcrManager(join(root, "ocr")), { layout,
    snapshot: async () => ({ fingerprint: "ocr", service: new OcrService([{ info, async recognize() { return content; } }], "test") }),
  });
  const run = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  const path = run.documents[0]!.preparationPath!;
  expect((await readPreparedDocument(root, "contract.pdf", path)).version).toBe("review-preparation-2");
  await expect(readPreparedDocument(root, "contract.pdf", "../outside.json")).rejects.toThrow("Invalid prepared");
  await writeFile(join(root, "contract.pdf"), "changed source");
  await expect(readPreparedDocument(root, "contract.pdf", path)).rejects.toThrow("changed");
}, 10_000);

test("cancellation during layout resumes the already saved transcription", async () => {
  const root = await fixture(); let calls = 0, first = true;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { entered = resolve; });
  const service = new DocumentPreparation(new OcrManager(join(root, "ocr")), {
    layout: { fingerprint: "cancel-layout", async detect(page, signal) {
      if (first) { first = false; entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
      return layout.detect(page, signal);
    } }, snapshot: async () => ({ fingerprint: "ocr", service: new OcrService([{ info, async recognize() { calls++; return content; } }], "test") }),
  });
  const run = await service.start(root, { files: ["contract.pdf"] }); await gate;
  await service.cancel(root, run.id);
  const resumed = await done(service, root, (await service.start(root, { files: ["contract.pdf"] })).id);
  expect(resumed.status).toBe("complete"); expect(calls).toBe(2);
}, 10_000);
