import { expect, test } from "bun:test";
import { z } from "zod";
import { ReviewResultQueries, RESULT_QUERY_PAGE_BYTES } from "./result-query-pages.js";
import { queryCells } from "./result-query.js";
import { SavedReviewSchema } from "./schema.js";

function fixture(documents = 4, columns = 15) {
  const definitions = Array.from({ length: columns }, (_, i) => ({ key: `column-${i}`, label: `Question ${i}`, kind: "classification", question: `Does condition ${i} apply?`, options: ["Yes", "No", "Not found"], hint: "" }));
  return SavedReviewSchema.parse({ id: "eae18172-80c0-40a7-b59b-c4ef79054436", name: "Commercial review", revision: 220, createdAt: 0, updatedAt: 1,
    settings: { mode: "mixed", jev: { providerId: "firm", model: "jev" }, llm: null }, status: "complete", runId: null, columns: definitions,
    documents: Array.from({ length: documents }, (_, i) => ({ id: `doc-${i}`, name: `Contract ${i}.pdf`, path: `${i}.pdf`, sourceHash: "hash", status: "ready" })),
    cells: Array.from({ length: documents }, (_, i) => definitions.map(column => ({ documentId: `doc-${i}`, columnKey: column.key, status: "complete", result: {
      value: i % 2 ? "No" : "Yes", reason: "", evidence: "uncited", confidence: null, citations: [], backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: "hash", completedAt: 10, prompt: column,
      decision: { type: "noul", noul: i % 2 ? .05 : .95 },
    } }))).flat(),
  });
}
const item = z.object({ type: z.string(), value: z.string().nullable().optional(), documentId: z.string().optional(), columnKey: z.string().optional(), count: z.number().optional(), text: z.string().optional() }).passthrough();

test("60-cell overview is one compact response; 2,000-cell aggregates cover the complete review", async () => {
  const queries = new ReviewResultQueries();
  for (const [docs, cols] of [[4, 15], [100, 20]]) {
    const review = fixture(docs, cols), before = JSON.stringify(review);
    const page = await queries.read("project", review.id, {}, async () => review);
    expect(page.nextCursor).toBeNull(); expect(page.coverage.complete).toBe(true);
    expect(page.summary.matchingCells).toBe(docs * cols);
    expect(page.scope.summaryCoversAllMatches).toBe(true);
    const distribution = page.items.map(value => item.parse(value)).filter(row => row.type === "distribution");
    expect(distribution).toHaveLength(cols * 2);
    expect(distribution.every(row => row.count === docs / 2)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(RESULT_QUERY_PAGE_BYTES);
    expect(JSON.stringify(page)).not.toContain("questionUsed");
    expect(JSON.stringify(review)).toBe(before);
  }
});

test("filters, search and aggregates distinguish absent, uncertain and stale answers", async () => {
  const review = fixture(4, 1);
  review.cells[0].result!.value = "Not found"; review.cells[0].result!.evidence = "absent";
  review.cells[1].status = "needs_review"; review.cells[1].result!.evidence = "uncertain";
  review.cells[2].status = "stale";
  review.cells[3].result!.citations = [{ page: 2, quote: "Die Änderung betrifft Subunternehmer." }];
  const queries = new ReviewResultQueries();
  const page = await queries.read("project", review.id, {}, async () => review);
  expect(page.summary).toMatchObject({ matchingCells: 4, acceptedAnswers: 2, absentAnswers: 1, matchingStatuses: { needsReview: 1, stale: 1 } });
  expect(queryCells(review, { values: ["No"] }).cells.map(cell => cell.documentId)).toEqual(["doc-3"]);
  expect(queryCells(review, { evidence: ["absent"] }).cells).toHaveLength(1);
  expect(queryCells(review, { query: "ÄNDERUNG", searchIn: ["citations"] }).cells.map(cell => cell.documentId)).toEqual(["doc-3"]);
  expect(queryCells(review, { query: "condition" }).cells).toHaveLength(0);
  expect(queryCells(review, { documentIds: ["doc-1", "doc-3"], statuses: ["needs_review"] }).cells).toHaveLength(1);
});

test("value comparisons/sorts use numeric and date types and isolate currencies", () => {
  const review = fixture(4, 1), column = review.columns[0];
  column.kind = "currency"; column.options = [];
  [1500000, 2000000, 900000, 0].forEach((amount, i) => { review.cells[i].result!.value = JSON.stringify({ amount, currency: i === 1 ? "USD" : "EUR" }); });
  review.cells[3].result!.value = "Not found"; review.cells[3].result!.evidence = "absent";
  expect(queryCells(review, { columnKeys: [column.key], currency: "EUR", valueFilter: { operator: "gt", value: 1000000 } }).cells.map(cell => cell.documentId)).toEqual(["doc-0"]);
  expect(() => queryCells(review, { columnKeys: [column.key], sort: { by: "value", direction: "asc" } })).toThrow("ISO currency");
  column.kind = "number";
  ["100", "9", "20", "Not found"].forEach((v, i) => { review.cells[i].result!.value = v; });
  expect(queryCells(review, { columnKeys: [column.key], sort: { by: "value", direction: "asc" } }).cells.map(cell => cell.documentId)).toEqual(["doc-1", "doc-2", "doc-0", "doc-3"]);
  expect(queryCells(review, { columnKeys: [column.key], sort: { by: "value", direction: "desc" } }).cells.at(-1)?.documentId).toBe("doc-3");
  column.kind = "percentage";
  expect(queryCells(review, { columnKeys: [column.key], valueFilter: { operator: "gte", value: 20 } }).cells).toHaveLength(2);
  column.kind = "date";
  ["2027-01-01", "2026-10-01", "2026-12-31", "Not found"].forEach((v, i) => { review.cells[i].result!.value = v; });
  expect(queryCells(review, { columnKeys: [column.key], valueFilter: { operator: "lt", value: "2027-01-01" } }).cells).toHaveLength(2);
  expect(() => queryCells(review, { columnKeys: [column.key], valueFilter: { operator: "eq", value: "2026-02-30" } })).toThrow("valid comparison date");
  expect(() => queryCells(review, { columnKeys: ["unknown"] })).toThrow("do not belong");
  expect(() => queryCells(review, { valueFilter: { operator: "gt", value: 10 } })).toThrow("exactly one column");
});

test("byte-bounded continuation preserves all 2,000 answers at one snapshot without manual revisions", async () => {
  const review = fixture(100, 20), queries = new ReviewResultQueries();
  let loads = 0;
  const load = async () => { loads++; return review; };
  let page = await queries.read("project", review.id, { view: "answers", limit: 200 }, load);
  const cells: string[] = [];
  review.revision++; review.cells.forEach(cell => { cell.result!.value = "Changed"; });
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(RESULT_QUERY_PAGE_BYTES);
    expect(page.review.revision).toBe(220); expect(page.summary.matchingCells).toBe(2000);
    for (const value of page.items) { const row = item.parse(value); expect(row.value).not.toBe("Changed"); cells.push(`${row.documentId}:${row.columnKey}`); }
    if (!page.nextCursor) break;
    page = await queries.read("project", review.id, { cursor: page.nextCursor }, load);
  }
  expect(cells).toHaveLength(2000); expect(new Set(cells).size).toBe(2000); expect(loads).toBe(1);
});

test("cursors cannot change scope/filters, be tampered with, or survive expiry", async () => {
  const review = fixture(); let now = 1;
  const queries = new ReviewResultQueries(() => now), load = async () => review;
  const first = await queries.read("project", review.id, { view: "answers", limit: 1 }, load);
  const cursor = first.nextCursor!;
  await expect(queries.read("another-project", review.id, { cursor }, load)).rejects.toThrow("expired or is unavailable");
  await expect(queries.read("project", "another-review", { cursor }, load)).rejects.toThrow("expired or is unavailable");
  await expect(queries.read("project", review.id, { cursor, values: ["Yes"] }, load)).rejects.toThrow("continuation needs only");
  await expect(queries.read("project", review.id, { cursor: cursor + "x" }, load)).rejects.toThrow("Invalid results cursor");
  await expect(queries.read("project", review.id, { cursor: cursor.split(".").slice(0, 2).join(".") + "." + "ä".repeat(43) }, load)).rejects.toThrow("Invalid results cursor");
  now += 16 * 60_000;
  await expect(queries.read("project", review.id, { cursor }, load)).rejects.toThrow("expired or is unavailable");
});

test("long multilingual evidence is paged without losing quote text or either probability", async () => {
  const review = fixture(1, 1), quote = "Änderung 🧾 / subcontractors \"quoted\".\n".repeat(1800);
  review.cells[0].result!.citations = [{ page: 3, quote }];
  review.cells[0].result!.value = quote;
  const queries = new ReviewResultQueries(), load = async () => review;
  let page = await queries.read("project", review.id, { view: "evidence", limit: 200 }, load);
  let actual = "", answer = ""; const probabilities: unknown[] = [];
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(RESULT_QUERY_PAGE_BYTES);
    for (const value of page.items) {
      const row = item.parse(value);
      if (row.type === "citation") actual += row.text;
      if (row.type === "answer_text") answer += row.text;
      if (row.type === "probabilities") probabilities.push(...z.object({ outcomes: z.array(z.unknown()) }).parse(value).outcomes);
    }
    if (!page.nextCursor) break;
    page = await queries.read("project", review.id, { cursor: page.nextCursor }, load);
  }
  expect(actual).toBe(quote); expect(answer).toBe(quote); expect(probabilities).toEqual([{ label: "Yes", probability: .95 }, { label: "No", probability: 1 - .95 }]);
});

test("large overviews paginate their distributions explicitly without dropping columns or counts", async () => {
  const review = fixture(100, 60), queries = new ReviewResultQueries(), load = async () => review;
  let page = await queries.read("project", review.id, {}, load), columns = 0, count = 0;
  expect(page.coverage.complete).toBe(false);
  do {
    expect(page.summary.matchingCells).toBe(6000);
    for (const value of page.items) { const row = item.parse(value); if (row.type === "column") columns++; if (row.type === "distribution") count += row.count!; }
    if (!page.nextCursor) break;
    page = await queries.read("project", review.id, { cursor: page.nextCursor }, load);
  } while (true);
  expect(columns).toBe(60); expect(count).toBe(6000);
});
