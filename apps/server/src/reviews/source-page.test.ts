import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewRecognitionPage, reviewSourcePage } from "./source-page.js";
import { ReviewResultSchema } from "./schema.js";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { PageStructureSchema } from "@legalwork/types/document-structure";

test("source preview highlights validated OCR regions and rejects stale or escaped evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-source-page-")));
  try {
    const bytes = await readFile(new URL("../ocr/fixtures/bilingual.png", import.meta.url));
    await writeFile(join(root, "contract.png"), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex"), box = { x: .1, y: .1, width: .5, height: .2 };
    await writeFile(join(root, "prepared.json"), JSON.stringify({ version: "review-preparation-1", key: "fixture", file: "contract.png", fileAbs: join(root, "contract.png"), sourceSha256: hash, engine: { id: "fixture", label: "Fixture", model: "fixture", execution: "local" }, pageCount: 1, status: "complete", pages: [{ page: 1, nativeText: "", status: "complete", width: 1000, height: 260, ocr: { text: "Handwritten addition", regions: [{ text: "Handwritten addition", box }] } }] }));
    const result = ReviewResultSchema.parse({ value: "Needs attention", reason: "", citations: [{ page: 1, source: "ocr", quote: "Handwritten addition", regionIds: [0] }], confidence: "low", evidence: "cited", backend: "llm", providerId: "fixture", model: "fixture", requestedModel: "fixture", sourceHash: hash, preparationPath: "prepared.json", prompt: { key: "term", label: "Term", question: "Is the term modified?", kind: "yes_no" }, completedAt: Date.now() });
    const preview = await reviewSourcePage(root, "contract.png", result, 0, new AbortController().signal);
    expect(preview.regions).toEqual([box]); expect(preview.image.startsWith("data:image/png;base64,")).toBe(true); expect(preview.page).toBe(1);
    const wrapped = await reviewSourcePage(root, "contract.png", { ...result, citations: [{ ...result.citations[0], quote: "Handwritten\naddition" }] }, 0, new AbortController().signal);
    expect(wrapped.regions).toEqual([box]);
    const automatic = await reviewSourcePage(root, "contract.png", { ...result, citations: [{ page: 1, source: "ocr", quote: "Handwritten addition" }] }, 0, new AbortController().signal);
    expect(automatic.regions).toEqual([box]);
    await expect(reviewSourcePage(root, "contract.png", { ...result, citations: [{ ...result.citations[0], quote: "Invented addition" }] }, 0, new AbortController().signal)).rejects.toThrow("regions");
    await expect(reviewSourcePage(root, "contract.png", { ...result, citations: [{ ...result.citations[0], regionIds: [4] }] }, 0, new AbortController().signal)).rejects.toThrow("regions");
    await symlink(tmpdir(), join(root, "outside"));
    await expect(reviewSourcePage(root, "contract.png", { ...result, preparationPath: "outside" }, 0, new AbortController().signal)).rejects.toThrow("Invalid document evidence");
    await writeFile(join(root, "contract.png"), "changed");
    await expect(reviewSourcePage(root, "contract.png", result, 0, new AbortController().signal)).rejects.toThrow("changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native PDF quotations highlight only cited sentence spans, across lines, pages and rotations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-native-source-")));
  try {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    const prefix = "Unrelated text. ", quote = "The notice period is 30 days.";
    pdf.addPage([400, 400]).drawText(prefix + quote + " Other text.", { x: 20, y: 350, size: 12, font });
    const second = pdf.addPage([400, 400]);
    second.drawText("Die Kündigungsfrist beträgt", { x: 20, y: 350, size: 12, font });
    second.drawText("dreißig Tage. Unrelated text.", { x: 20, y: 330, size: 12, font });
    second.setRotation(degrees(90));
    second.setCropBox(10, 10, 380, 380);
    const bytes = await pdf.save(); await writeFile(join(root, "contract.pdf"), bytes);
    const result = ReviewResultSchema.parse({ value: "30 days", reason: "", citations: [{ page: 1, source: "native", quote }], confidence: "high", evidence: "cited", backend: "llm", providerId: "fixture", model: "fixture", requestedModel: "fixture", sourceHash: createHash("sha256").update(bytes).digest("hex"), prompt: { key: "notice", label: "Notice", question: "What is the notice period?", kind: "text" }, completedAt: Date.now() });
    const first = await reviewSourcePage(root, "contract.pdf", result, 0, new AbortController().signal);
    expect(first.regions).toHaveLength(1);
    const region = first.regions[0];
    expect(region.x).toBeCloseTo((20 + font.widthOfTextAtSize(prefix, 12)) / 400, 2);
    expect(region.width).toBeCloseTo(font.widthOfTextAtSize(quote, 12) / 400, 2);
    expect(region.y).toBeGreaterThan(.08); expect(region.y).toBeLessThan(.13);
    expect(region.height).toBeCloseTo(12 / 400, 2);
    const structure = (id: string, text: string) => PageStructureSchema.parse({
      version: "document-structure-1", model: "fixture", status: "complete", readingOrder: [id], tables: [], marks: [], issues: [],
      regions: [{ id, kind: "text", label: "text", box: { x: .1, y: .1, width: .5, height: .1 }, text,
        ocrRegionIds: [], order: 0, writing: "printed", source: "layout" }],
    });
    const relation = { id: "r1", kind: "continues", source: { page: 1, regionId: "p1" }, target: { page: 2, regionId: "p2" },
      status: "candidate", basis: "page-boundary", explanation: "Possible continuation" };
    await writeFile(join(root, "prepared.json"), JSON.stringify({ version: "review-preparation-2", key: "fixture", file: "contract.pdf", fileAbs: join(root, "contract.pdf"),
      sourceSha256: result.sourceHash, engine: { id: "fixture", label: "Fixture", model: "fixture", execution: "local" },
      pageCount: 2, status: "complete", relations: [relation], pages: [
        { page: 1, nativeText: prefix + quote, ocr: null, width: 400, height: 400, status: "complete", structure: structure("p1", quote) },
        { page: 2, nativeText: "Die Kündigungsfrist beträgt dreißig Tage.", ocr: null, width: 400, height: 400, status: "complete", structure: structure("p2", "Continuation") },
      ] }));
    const structured = { ...result, preparationPath: "prepared.json" };
    const withStructure = await reviewSourcePage(root, "contract.pdf", structured, 0, new AbortController().signal);
    expect(withStructure.structure?.regions[0]?.text).toBe(quote);
    expect(withStructure.relatedPassages?.[0]).toMatchObject({ page: 2, relation: { status: "candidate" }, region: { text: "Continuation" } });
    const next = await reviewSourcePage(root, "contract.pdf", structured, 0, new AbortController().signal, 2);
    expect(next.page).toBe(2); expect(next.quote).toBe(""); expect(next.regions).toEqual([]);
    expect(next.relatedPassages?.[0]).toMatchObject({ page: 1, direction: "incoming" });
    await expect(reviewSourcePage(root, "contract.pdf", { ...structured, citations: [{ page: 1, source: "native", quote: "Invented quote" }] }, 0, new AbortController().signal, 2)).rejects.toThrow("source page");
    await expect(reviewSourcePage(root, "contract.pdf", structured, 0, new AbortController().signal, 3)).rejects.toThrow("does not exist");
    // Existing results without source/region metadata work without rerunning inference.
    const legacy = await reviewSourcePage(root, "contract.pdf", { ...result, citations: [{ page: 1, quote }] }, 0, new AbortController().signal);
    expect(legacy.regions).toEqual(first.regions);
    const rotated = await reviewSourcePage(root, "contract.pdf", { ...result, citations: [{ page: 2, source: "native", quote: "Die Kündigungsfrist beträgt dreißig Tage." }] }, 0, new AbortController().signal);
    expect(rotated.regions).toHaveLength(2);
    for (const box of rotated.regions) {
      expect(box.height).toBeGreaterThan(box.width);
      expect(box.x).toBeGreaterThan(.8); expect(box.x + box.width).toBeLessThanOrEqual(1);
      expect(box.y).toBeCloseTo(10 / 380, 2);
    }
    await expect(reviewSourcePage(root, "contract.pdf", { ...result, citations: [{ page: 2, source: "native", quote }] }, 0, new AbortController().signal)).rejects.toThrow("source page");
    await expect(reviewSourcePage(root, "contract.pdf", { ...result, citations: [{ page: 1, source: "native", quote: quote.replace("30", "60") }] }, 0, new AbortController().signal)).rejects.toThrow("source page");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recognition pages list every page's status and open the first page that needs review", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-recognition-")));
  try {
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 3; page++) pdf.addPage([300, 400]);
    const bytes = await pdf.save(), signal = new AbortController().signal;
    await writeFile(join(root, "scan.pdf"), bytes);
    const structure = PageStructureSchema.parse({ version: "document-structure-1", model: "fixture", status: "complete", readingOrder: ["b"], tables: [], marks: [], issues: [],
      regions: [{ id: "b", kind: "text", label: "text", box: { x: .1, y: .1, width: .5, height: .1 }, text: "Clause 1", ocrRegionIds: [], order: 0, writing: "printed", source: "layout" }] });
    // Page 1 is complete, page 2's output was dropped, page 3 was never prepared.
    await writeFile(join(root, "prepared.json"), JSON.stringify({ version: "review-preparation-4", key: "fixture", file: "scan.pdf", fileAbs: join(root, "scan.pdf"),
      sourceSha256: createHash("sha256").update(bytes).digest("hex"), engine: { id: "fixture", label: "Fixture", model: "fixture", execution: "local" },
      pageCount: 3, status: "needs-review", pages: [
        { page: 1, nativeText: "", ocr: { text: "Clause 1", regions: [], truncated: false }, width: 300, height: 400, status: "complete", structure },
        { page: 2, nativeText: "", ocr: { text: "", regions: [], truncated: true }, width: 300, height: 400, status: "needs-review", structure },
      ] }));
    const flagged = await reviewRecognitionPage(root, "scan.pdf", "prepared.json", signal);
    expect(flagged.page).toBe(2);
    expect(flagged.pages).toEqual([{ page: 1, status: "complete", reasons: [] }, { page: 2, status: "needs-review", reasons: ["no-text", "output-dropped"] },
      { page: 3, status: "missing", reasons: [] }]);
    const first = await reviewRecognitionPage(root, "scan.pdf", "prepared.json", signal, 1);
    expect([first.text, first.structure?.regions[0]?.text, first.image.startsWith("data:image/png;base64,")]).toEqual(["Clause 1", "Clause 1", true]);
    await expect(reviewRecognitionPage(root, "scan.pdf", "prepared.json", signal, 4)).rejects.toThrow("does not exist");
    await writeFile(join(root, "scan.pdf"), "changed");
    await expect(reviewRecognitionPage(root, "scan.pdf", "prepared.json", signal)).rejects.toThrow("no longer matches");
  } finally { await rm(root, { recursive: true, force: true }); }
});
