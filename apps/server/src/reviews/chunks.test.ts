import { expect, test } from "bun:test";
import { splitReviewEvidence, combineReviewChunks, type EvidencePage } from "./chunks.js";
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
