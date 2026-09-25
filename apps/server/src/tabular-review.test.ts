import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewEvidence, parseReviewCells, ReviewRowArgs } from "./tabular-review.js";

const columns = [{ key: "term", label: "Term", question: "What is the term?", decision: { type: "noul", instructions: "Is the term 60 days?" } }];
const args = (backend = "llm") => ReviewRowArgs.parse({ backend, providerId: "test", model: "test", file: "source.pdf", title: "Contract", preparationPath: "prepared.json", columns });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-"));
  const file = join(root, "source.pdf");
  await writeFile(file, "source");
  const doc = {
    version: "review-preparation-1", key: "test", file: "source.pdf", fileAbs: file,
    sourceSha256: createHash("sha256").update("source").digest("hex"),
    engine: { id: "ocr", label: "OCR", model: "ocr", execution: "local" },
    status: "complete", pageCount: 1, pages: [{
      page: 1, status: "complete", width: 100, height: 100, nativeText: "Base term 30 days.",
      ocr: { text: "Addition 60 days.", truncated: false, regions: [{ text: "Addition 60 days.", box: { x: .1, y: .1, width: .5, height: .2 } }] },
    }],
  };
  const save = () => writeFile(join(root, "prepared.json"), JSON.stringify(doc));
  await save();
  return { root, file, doc, save };
};

test("review loads native/OCR evidence with regions, rejects stale and out-of-workspace sources", async () => {
  const f = await fixture();
  try {
    const loaded = await loadReviewEvidence(args(), f.root);
    expect(loaded.preparationPath).toBe("prepared.json");
    expect(loaded.pages.map(p => p.source)).toEqual(["native", "ocr"]);
    const cell = { value: "30 days, amended to 60", reason: "Handwritten addition", quote: "Base term 30 days.", page: 1, location: "", confidence: "high", citations: [
      { page: 1, quote: "Base term 30 days.", source: "native" },
      { page: 1, quote: "Addition 60 days.", source: "ocr", regionIds: [0] },
    ] };
    expect(parseReviewCells(loaded, JSON.stringify({ cells: { term: cell } })).term.citations).toHaveLength(2);
    cell.citations[1].regionIds = [3];
    expect(() => parseReviewCells(loaded, JSON.stringify({ cells: { term: cell } }))).toThrow("regions");
    await writeFile(f.file, "changed");
    await expect(loadReviewEvidence(args(), f.root)).rejects.toThrow("changed");
    await symlink(tmpdir(), join(f.root, "outside"));
    await expect(loadReviewEvidence({ ...args(), preparationPath: "outside" }, f.root)).rejects.toThrow("inside");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uncertain OCR blocks SystemOne, downgrades LLM absence and preserves cited findings", async () => {
  const f = await fixture();
  try {
    f.doc.status = "needs-review"; f.doc.pages[0].status = "needs-review"; await f.save();
    await expect(loadReviewEvidence(args("systemone"), f.root)).rejects.toThrow("incomplete or uncertain");
    const loaded = await loadReviewEvidence(args(), f.root);
    const absent = { value: "Not found", reason: "", quote: "", page: null, location: "", confidence: "low" };
    expect(parseReviewCells(loaded, JSON.stringify({ cells: { term: absent } })).term.value).toBe("Needs review");
    const found = { ...absent, value: "60 days", quote: "Addition 60 days.", page: 1, confidence: "high", citations: [{ page: 1, quote: "Addition 60 days.", source: "ocr", regionIds: [0] }] };
    expect(parseReviewCells(loaded, JSON.stringify({ cells: { term: found } })).term.confidence).toBe("low");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
