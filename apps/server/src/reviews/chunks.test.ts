import { expect, test } from "bun:test";
import { splitReviewEvidence, combineReviewChunks, type EvidencePage } from "./chunks.js";
import type { DocumentRelation } from "@legalwork/types/document-structure";
import { structureOffsets } from "./evidence.js";
test("splitting keeps every source character and overlapping context, including empty first pages", () => {
  const pages: EvidencePage[] = [{ page: 1, text: "", status: "needs-review" }, { page: 2, text: "A sentence. ".repeat(500), source: "native" }, { page: 2, text: "A handwritten exception.", source: "ocr" }];
  const chunks = splitReviewEvidence(pages, 1000, 150);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(chunk => chunk.end - chunk.start <= 1000)).toBe(true);
  expect(chunks[1].start).toBeLessThan(chunks[0].end);
  const combined = combineReviewChunks(chunks, pages, 10_000)!;
  expect(combined.filter(page => page.source === "native").map(page => page.text).join("")).toBe(pages[1].text);
  expect(combined.at(-1)).toMatchObject({ page: 2, text: pages[2].text, source: "ocr" });
  expect(combineReviewChunks(chunks, pages, 1000)).toBeNull();
});
test("source identities remain separate when native text and OCR share a page", () => {
  const pages: EvidencePage[] = [{ page: 1, text: "Main term " + "x".repeat(90), source: "native" }, { page: 1, text: "Margin exception", source: "ocr", regions: [{ text: "Margin exception" }] }];
  const chunks = splitReviewEvidence(pages, 110, 20);
  expect(combineReviewChunks(chunks, pages, 200)?.map(page => page.source)).toEqual(["native", "ocr"]);
});
test("one-hop links expand selected passages in both page directions with candidate metadata", () => {
  const pages: EvidencePage[] = [
    { page: 1, source: "ocr", text: "Main term applies.", blocks: [{ id: "main", kind: "text", start: 0, end: 18, ocrRegionIds: [7] }],
      regions: Array.from({ length: 8 }, (_, index) => ({ text: index === 7 ? "Main term applies." : "unrelated" })) },
    { page: 2, source: "ocr", text: "Handwritten exception.", blocks: [{ id: "exception", kind: "note", start: 0, end: 22, ocrRegionIds: [3] }] },
  ];
  const link: DocumentRelation = { id: "link", kind: "annotates", source: { page: 1, regionId: "main" },
    target: { page: 2, regionId: "exception" }, status: "candidate", basis: "arrow", explanation: "Arrow observed." };
  const chunks = splitReviewEvidence(pages, 100, 0);
  expect(chunks).toHaveLength(1);
  const first = { index: 0, start: 0, end: pages[0].text.length, pages: [pages[0]] };
  const second = { index: 1, start: pages[0].text.length + 2, end: pages[0].text.length + 2 + pages[1].text.length, pages: [pages[1]] };
  for (const chosen of [first, second]) {
    const combined = combineReviewChunks([chosen], pages, 1000, [link]);
    expect(combined?.map(page => page.page)).toEqual([1, 2]);
    expect(combined?.[0].links).toEqual([{ kind: "annotates", status: "candidate", basis: "arrow",
      source: link.source, target: link.target }]);
    expect(combined?.[0].blocks?.[0].ocrRegionIds).toEqual([7]);
  }
});
test("serialized budget counts metadata and refuses oversized linked context", () => {
  const pages: EvidencePage[] = [
    { page: 1, text: "A".repeat(120), source: "ocr", blocks: [{ id: "a", kind: "text", start: 0, end: 120 }],
      regions: [{ text: "x".repeat(50_000) }] },
    { page: 2, text: "B".repeat(800), source: "ocr", blocks: [{ id: "b", kind: "text", start: 0, end: 800 }] },
  ];
  const link: DocumentRelation = { id: "link", kind: "continues", source: { page: 1, regionId: "a" },
    target: { page: 2, regionId: "b" }, status: "candidate", basis: "page-boundary", explanation: "Boundary" };
  const chosen = { index: 0, start: 0, end: 120, pages: [pages[0]] };
  expect(combineReviewChunks([chosen], pages, 500, [link])).toBeNull();
  expect(combineReviewChunks([chosen], pages, 2000, [link])?.map(page => page.text)).toEqual([pages[0].text, pages[1].text]);
  expect(splitReviewEvidence([{ page: 1, text: "short", blocks: Array.from({ length: 50 }, (_, index) =>
    ({ id: `very-long-region-${index}`, kind: "text", start: 0, end: 5 })) }], 100, 0, true)).toEqual([]);
});
test("noncontiguous OCR lines keep their original zero-based region IDs and exact offsets", () => {
  const structure = { version: "document-structure-1" as const, model: "fixture", status: "complete" as const,
    regions: [{ id: "clause", kind: "text" as const, label: "text", box: { x: .1, y: .1, width: .8, height: .5 },
      text: "First line\nThird line", ocrRegionIds: [0, 2], order: 0, writing: "unknown" as const,
      source: "layout+ocr" as const }], readingOrder: ["clause"], tables: [], marks: [], issues: [] };
  const text = "First line\nUnrelated line\nThird line";
  const result = structureOffsets(text, structure, [{ text: "First line" }, { text: "Unrelated line" }, { text: "Third line" }]);
  expect(result.blocks.map(block => ({ text: text.slice(block.start, block.end), ids: block.ocrRegionIds })))
    .toEqual([{ text: "First line", ids: [0] }, { text: "Third line", ids: [2] }]);
  const unavailable = structureOffsets("First line", structure, [{ text: "Different OCR line" }]);
  expect(unavailable.blocks).toEqual([]);
});
test("linked chains include every reachable passage within a bounded closure", () => {
  const pages: EvidencePage[] = ["A", "B", "C"].map((text, index) => ({ page: index + 1, source: "ocr", text,
    blocks: [{ id: text, kind: "text", start: 0, end: 1 }] }));
  const links: DocumentRelation[] = [
    { id: "ab", kind: "annotates", source: { page: 1, regionId: "A" }, target: { page: 2, regionId: "B" },
      status: "candidate", basis: "arrow", explanation: "fixture" },
    { id: "bc", kind: "annotates", source: { page: 2, regionId: "B" }, target: { page: 3, regionId: "C" },
      status: "candidate", basis: "arrow", explanation: "fixture" },
  ];
  expect(combineReviewChunks([{ index: 0, start: 0, end: 1, pages: [pages[0]] }], pages, 1000, links)
    ?.map(page => page.text)).toEqual(["A", "B", "C"]);
  const longer = Array.from({ length: 66 }, (_, index): EvidencePage => ({ page: index + 1, source: "ocr", text: "x",
    blocks: [{ id: `r${index}`, kind: "text", start: 0, end: 1 }] }));
  const chain = longer.slice(1).map((_, index): DocumentRelation => ({ id: `l${index}`, kind: "continues",
    source: { page: index + 1, regionId: `r${index}` }, target: { page: index + 2, regionId: `r${index + 1}` },
    status: "candidate", basis: "page-boundary", explanation: "fixture" }));
  expect(combineReviewChunks([{ index: 0, start: 0, end: 1, pages: [longer[0]] }], longer, 100_000, chain)).toBeNull();
});
