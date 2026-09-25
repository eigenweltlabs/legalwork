import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewSourcePage } from "./source-page.js";
import { ReviewResultSchema } from "./schema.js";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

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
