import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { searchFileContents } from "./content-search.js";
import { DocumentPreparation } from "./document-preparation/service.js";
import { OcrManager } from "./ocr/manager.js";
import { OcrService } from "./ocr/service.js";
import { extractCorpusText } from "./corpus/extract.js";
import { documentMatches } from "./corpus/passages.js";
import { reviewSourcePage } from "./reviews/source-page.js";
import type { WorkspaceInfo } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(fail = false, layoutAvailable = true) {
  const scratch = fileURLToPath(new URL("../../../.legalwork/scratch/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await realpath(await mkdtemp(join(scratch, "search-fixture-")));
  let calls = 0;
  const box = { x: .1, y: .2, width: .6, height: .1 };
  const preparation = new DocumentPreparation(new OcrManager(join(root, ".ocr")), {
    layout: { fingerprint: "fixture-layout", async detect() {
      if (!layoutAvailable) throw new Error("Layout unavailable");
      return { model: "fixture-layout", regions: [{ label: "text", box, confidence: .99, order: 0 }] };
    } },
    snapshot: async () => {
    if (fail) throw new Error("OCR unavailable");
    return { fingerprint: "fixture", service: new OcrService([{ info: { id: "fixture", label: "Fixture", execution: "local", model: "fixture", regions: true, languages: null, warnings: [] }, recognize: async () => {
      calls++;
      return { text: "Handwritten amendment: quarterly escrow deposits.", regions: [{ text: "Handwritten amendment: quarterly escrow deposits.", box }], truncated: false };
    } }], "fixture") };
  } });
  cleanups.push(async () => { preparation.stop(); await rm(root, { recursive: true, force: true }); });
  const workspace: WorkspaceInfo = { id: "search-fixture", name: "Fixture", path: root, preset: "starter", workspaceType: "local" };
  return { root, workspace, preparation, box, calls: () => calls, setFailure: (value: boolean) => { fail = value; } };
}
const signal = () => new AbortController().signal;
async function settled(f: Awaited<ReturnType<typeof fixture>>, query: string) {
  for (let index = 0; index < 200; index++) {
    const result = await searchFileContents(f.workspace, query, signal(), f.preparation);
    if (!result.preparing) return result;
    await Bun.sleep(20);
  }
  throw new Error("Search did not finish preparing");
}

test("shared extraction detects additions on native PDFs and preserves OCR evidence locations", async () => {
  const f = await fixture();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 400]);
  page.drawText("This native contract contains enough typed text for the old fast path.", { x: 20, y: 330, size: 12 });
  page.drawLine({ start: { x: 20, y: 100 }, end: { x: 130, y: 110 }, thickness: 2 });
  await writeFile(join(f.root, "annotated.pdf"), await pdf.save());
  const shared = await extractCorpusText(f.root, "annotated.pdf", f.preparation, signal());
  expect(shared.complete).toBe(true); expect(shared.extraction).toBe("ocr"); expect(f.calls()).toBe(1);
  const agentMatches = documentMatches(shared, "annotated.pdf", "quarterly escrow");
  const ui = await settled(f, "quarterly escrow");
  expect(ui.items).toHaveLength(1); expect(ui.items[0].sources).toEqual(agentMatches.sources);
  expect(f.calls()).toBe(1); // UI reuses the same prepared document.
  const ref = ui.items[0].sources?.find(source => source.source === "ocr");
  if (!ref) throw new Error("Missing OCR reference");
  const preview = await reviewSourcePage(f.root, ref.path, { sourceHash: ref.hash, preparationPath: ref.preparationPath, citations: [ref] }, 0, signal());
  expect(preview.page).toBe(1); expect(preview.regions).toEqual([f.box]);
  await writeFile(join(f.root, "annotated.pdf"), "changed");
  await expect(reviewSourcePage(f.root, ref.path, { sourceHash: ref.hash, preparationPath: ref.preparationPath, citations: [ref] }, 0, signal())).rejects.toThrow("changed");
});

test("a clause split across pages returns every contributing passage", () => {
  const pages = [{ page: 1, text: "Upon a transfer of ownership," }, { page: 2, text: "the counterparty may terminate this agreement." }];
  const result = documentMatches({ pages, text: pages.map(page => page.text).join("\n\n"), hash: "hash", complete: true, extraction: "native" }, "split.pdf", "ownership terminate");
  expect(result.sources.map(source => source.page)).toEqual([1, 2]);
  expect(result.sources[1].quote).toContain("terminate");
});

test("missing layout preserves searchable OCR locations but reports incomplete evidence", async () => {
  const f = await fixture(false, false);
  await writeFile(join(f.root, "scan.png"), await readFile(new URL("./ocr/fixtures/bilingual.png", import.meta.url)));
  const shared = await extractCorpusText(f.root, "scan.png", f.preparation, signal());
  expect(shared.complete).toBe(false);
  expect(shared.pages.find(page => page.source === "ocr")?.regions?.[0].box).toEqual(f.box);
  const result = await settled(f, "quarterly escrow");
  expect(result.items).toHaveLength(1);
  expect(result.items[0].incomplete).toBe(true);
  expect(result.incomplete).toBe(1);
  expect(result.retryable).toBe(true);
  expect(f.calls()).toBe(1);
});

test("unreadable images are reported, partial native text remains searchable, and external symlinks are excluded", async () => {
  const f = await fixture(true), other = await fixture();
  const png = await readFile(new URL("./ocr/fixtures/bilingual.png", import.meta.url));
  await writeFile(join(f.root, "scan.png"), png);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage(); page.drawText("Native agreement with ownership provision.");
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: 100, y: 100 } });
  await writeFile(join(f.root, "partial.pdf"), await pdf.save());
  await writeFile(join(other.root, "outside.txt"), "ownership");
  await symlink(join(other.root, "outside.txt"), join(f.root, "outside.txt"));
  const result = await settled(f, "ownership");
  expect(result.incomplete).toBe(2); expect(result.retryable).toBe(true);
  expect(result.items.map(item => item.path)).toEqual(["partial.pdf"]);
  expect(result.items[0].incomplete).toBe(true);
  expect(result.issues?.some(issue => issue.path === "scan.png")).toBe(true);
});

test("plain text stays independent of OCR and cache invalidates when the source changes", async () => {
  const f = await fixture(true);
  await writeFile(join(f.root, "terms.txt"), "Quarterly deposits are required.");
  expect((await settled(f, "quarterly")).items).toHaveLength(1);
  await writeFile(join(f.root, "terms.txt"), "Annual deposits replace the prior requirement.");
  expect((await settled(f, "quarterly")).items).toHaveLength(0);
  expect((await settled(f, "annual")).items).toHaveLength(1);
  expect(f.calls()).toBe(0);
});

test("retry recovers every unreadable file across the background concurrency limit", async () => {
  const f = await fixture(true);
  const png = await readFile(new URL("./ocr/fixtures/bilingual.png", import.meta.url));
  for (const name of ["first.png", "second.png", "third.png"]) await writeFile(join(f.root, name), png);
  expect((await settled(f, "escrow")).incomplete).toBe(3);
  f.setFailure(false);
  await searchFileContents(f.workspace, "escrow", signal(), f.preparation, true);
  const recovered = await settled(f, "escrow");
  expect(recovered.items).toHaveLength(3);
  expect(recovered.incomplete).toBe(0);
  expect(recovered.retryable).toBe(false);
});
