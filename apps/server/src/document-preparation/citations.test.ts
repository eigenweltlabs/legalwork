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
test("localized builtin fallback answers retain absence and uncertainty semantics", () => {
  const columns = [{ key: "term", fallback: { absent: "Nicht gefunden", uncertain: "Unklar" } }];
  const empty = { ...result, quote: "", page: null, citations: [] };
  expect(parseReviewCells({ columns, pages: input.pages.slice(0, 2) }, JSON.stringify({ cells: { term: { ...empty, value: "Nicht gefunden" } } })).term.value).toBe("Not found");
  for (const value of ["Nicht gefunden", "Unklar"]) {
    expect(parseReviewCells({ ...input, columns }, JSON.stringify({ cells: { term: { ...empty, value } } })).term.value).toBe("Needs review");
  }
  // A custom classification label is not silently reinterpreted.
  expect(() => parse({ ...empty, value: "Unklar" })).toThrow("citation");
});
test("missing section labels do not reject grounded or uncertain answers", () => {
  const { location: _location, ...withoutLabel } = result;
  expect(parse(withoutLabel).location).toBe("");
  expect(parse({ ...withoutLabel, value: "Needs review", quote: "", page: null, citations: [] }).location).toBe("");
  expect(() => parse({ ...withoutLabel, quote: "Invented passage" })).toThrow("citation");
});

test("layout whitespace is resolved to the exact source text while page, wording and regions stay verified", () => {
  const pages: ReviewEvidenceInput["pages"] = [{ page: 3, source: "ocr", status: "complete", text: "The notice\n  period is\u00a030 days (section 4).", regions: [{ text: "The notice period is 30 days (section 4)." }] }];
  const quote = "The notice period is 30 days (section 4).";
  const response = { ...result, quote, page: 3, citations: [{ page: 3, quote, source: "ocr", regionIds: [0] }] };
  const cell = parseReviewCells({ columns: [{ key: "term" }], pages }, JSON.stringify({ cells: { term: response } })).term;
  expect(cell.quote).toBe(pages[0].text);
  expect(cell.citations?.[0].quote).toBe(pages[0].text);
  for (const invalid of [quote.replace("30", "60"), quote.replace("(section 4).", "[section 4]."), "The notice ... 30 days (section 4)."])
    expect(() => parseReviewCells({ columns: [{ key: "term" }], pages }, JSON.stringify({ cells: { term: { ...response, quote: invalid } } }))).toThrow("citation");
  expect(() => parseReviewCells({ columns: [{ key: "term" }], pages }, JSON.stringify({ cells: { term: { ...response, page: 1 } } }))).toThrow("citation");
});

test("absence and uncertainty discard incidental citations instead of failing or claiming quoted evidence", () => {
  for (const value of ["Not found", "Needs review"]) {
    const cell = parseReviewCells({ ...input, pages: input.pages.slice(0, 2) }, JSON.stringify({ cells: { term: { ...result, value } } })).term;
    expect(cell).toMatchObject({ value, quote: "", page: null, location: "", confidence: "low", citations: [] });
  }
  expect(parse({ ...result, value: "Not found" })).toMatchObject({ value: "Needs review", quote: "", page: null, citations: [] });
  const columns = [{ key: "term", fallback: { absent: "Nicht gefunden", uncertain: "Unklar" } }];
  expect(parseReviewCells({ ...input, columns }, JSON.stringify({ cells: { term: { ...result, value: "Unklar" } } })).term)
    .toMatchObject({ value: "Needs review", quote: "", page: null, citations: [] });
});

test("unpaginated evidence is verified and canonicalized without inventing a page", () => {
  const cell = parseReviewCells({ columns: [{ key: "term" }], pages: [{ page: null, text: "Notice\nperiod: 30 days", source: "native" }] }, JSON.stringify({ cells: { term: { ...result, quote: "Notice period: 30 days", page: null, citations: [] } } })).term;
  expect(cell.quote).toBe("Notice\nperiod: 30 days"); expect(cell.page).toBeNull();
});
