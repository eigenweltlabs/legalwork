import { expect, test } from "bun:test";
import { parseReviewCells, type ReviewEvidenceInput } from "../reviews/citations.js";

const input: ReviewEvidenceInput = { columns: [{ key: "term" }], pages: [
  { page: 1, text: "Base term 30 days", source: "native", status: "complete" },
  { page: 1, text: "Addition 60 days", source: "ocr", status: "complete", regions: [{ text: "Addition 60 days" }] },
  { page: 2, text: "", source: "ocr", status: "error" },
] };
const result = { value: "30 days; handwritten note says 60", reason: "The addition conflicts with the base term.", quote: "Base term 30 days", page: 1, location: "Notice", confidence: "high", citations: [
  { page: 1, quote: "Base term 30 days", source: "native" }, { page: 1, quote: "Addition 60 days", source: "ocr", regionIds: [0] },
] };
const parse = (cell: unknown) => parseReviewCells(input, JSON.stringify({ cells: { term: cell } })).term;
test("native review preserves multiple citations including handwriting and OCR region indices", () => {
  const cell = parse(result); expect(cell.citations).toHaveLength(2); expect(cell.citations?.[1].regionIds).toEqual([0]);
});
test("fabricated quotes, pages and regions cannot become source citations", () => {
  expect(() => parse({ ...result, citations: [{ page: 1, quote: "90 days", source: "ocr" }] })).toThrow("citation");
  expect(() => parse({ ...result, citations: [result.citations[0], { ...result.citations[1], regionIds: [9] }] })).toThrow("regions");
  expect(() => parse({ ...result, page: 3 })).toThrow("citation");
});
test("incomplete evidence cannot produce an absence claim", () => {
  expect(parse({ ...result, value: "Not found", quote: "", page: null, citations: [] }).value).toBe("Needs review");
});
