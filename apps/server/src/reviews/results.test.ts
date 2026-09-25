import { expect, test } from "bun:test";
import { readReviewResults } from "./results.js";
import { SavedReviewSchema, type ReviewCell } from "./schema.js";

const decision = { key: "consent", label: "Consent required", question: "Does assignment require consent?", kind: "yes_no", options: [], hint: "" };
const text = { ...decision, key: "law", label: "Governing law", question: "What law applies?", kind: "text" };
const result = { value: "No", reason: "", confidence: null, evidence: "uncited", citations: [], backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: "hash", completedAt: 10, prompt: decision, decision: { type: "noul", noul: .01 } };
const statuses: ReviewCell["status"][] = ["complete", "needs_review", "stale", "blocked", "error", "queued"];
const review = SavedReviewSchema.parse({
  id: "eae18172-80c0-40a7-b59b-c4ef79054436", name: "Saved diligence", revision: 7, createdAt: 0, updatedAt: 10,
  settings: { mode: "mixed", jev: { providerId: "firm", model: "jev" }, llm: { providerId: "firm", model: "llm" } },
  columns: [decision, text], status: "needs_review", runId: null,
  documents: statuses.map((_, index) => ({ id: `doc-${index}`, path: `agreements/Contract ${index}.pdf`, name: `Contract ${index}.pdf`, status: "ready", sourceHash: "hash" })),
  cells: statuses.flatMap((status, index) => [
    { documentId: `doc-${index}`, columnKey: "consent", status, result: index < 3 ? { ...result, value: status === "needs_review" ? "Needs review" : "No", evidence: status === "needs_review" ? "uncertain" : "uncited" } : null,
      error: status === "error" ? "Provider unavailable" : null, blockedBy: status === "blocked" ? "systemone" : undefined },
    { documentId: `doc-${index}`, columnKey: "law", status: "complete", result: { ...result, prompt: text, value: "German law", reason: "The agreement selects German law.", backend: "llm", model: "llm", evidence: "cited", decision: undefined,
      citations: [{ page: 2, quote: "This agreement is governed by German law.", source: "native" }] } },
  ]),
});

test("results join documents, prompts, citations and both decision probabilities with full-set counts", () => {
  const output = readReviewResults(review, { limit: 2 });
  expect(output.review).toMatchObject({ id: review.id, revision: 7, status: "needs_review" });
  expect(output.summary).toMatchObject({ totalCells: 12, matchingCells: 12, matchingStatuses: { complete: 7, needsReview: 1, stale: 1, blocked: 1, error: 1, queued: 1 } });
  expect(output.cells).toHaveLength(2); expect(output.nextOffset).toBe(2);
  expect(output.cells[0]).toMatchObject({ documentName: "Contract 0.pdf", columnLabel: "Consent required", usableAnswer: true, result: { probabilities: [{ label: "Yes", probability: .01 }, { label: "No", probability: .99 }] } });
  expect(output.cells[1].result?.citations).toEqual([{ page: 2, quote: "This agreement is governed by German law.", source: "native" }]);
  expect(output.scope.sourceFilesRevalidated).toBe(false);
  expect(output.summary.columns[0].answers).toEqual([{ value: "No", count: 1 }]);
  expect(output.summary.columns[1].answers).toEqual([]);
});

test("result pagination is complete and refuses to combine different revisions", () => {
  const cells = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = readReviewResults(review, { revision: 7, offset, limit: 5 });
    cells.push(...page.cells.map(cell => `${cell.documentId}:${cell.columnKey}`));
    offset = page.nextOffset;
  }
  expect(new Set(cells).size).toBe(12); expect(cells).toHaveLength(12);
  expect(() => readReviewResults({ ...review, revision: 8 }, { revision: 7, offset: 5 })).toThrow("changed between result pages");
  expect(readReviewResults(review, { offset: 99 }).nextOffset).toBeNull();
});

test("filters compose and stale or uncertain answers cannot inflate accepted answer counts", () => {
  const found = readReviewResults(review, { columnKeys: ["consent"], values: ["No"] });
  expect(found.summary.matchingCells).toBe(1); expect(found.cells[0].documentId).toBe("doc-0");
  const attention = readReviewResults(review, { columnKeys: ["consent"], statuses: ["stale", "needs_review", "blocked", "error"] });
  expect(attention.summary.matchingCells).toBe(4); expect(attention.cells.every(cell => !cell.usableAnswer)).toBe(true);
  expect(attention.summary.columns[0].answers).toEqual([]);
  expect(attention.cells.find(cell => cell.status === "blocked")?.blockedBy).toBe("systemone");
  const source = readReviewResults(review, { documentIds: ["doc-2"], query: "GOVERNED BY GERMAN", statuses: ["complete"] });
  expect(source.cells).toHaveLength(1); expect(source.cells[0]).toMatchObject({ documentId: "doc-2", columnKey: "law" });
  expect(readReviewResults(review, { values: ["Missing"] }).summary.matchingCells).toBe(0);
});

test("read requests reject unknown documents, columns and unbounded or invalid input", () => {
  for (const input of [{ documentIds: ["outside"] }, { columnKeys: ["unknown"] }, { limit: 51 }, { offset: -1 }, { statuses: ["invented"] }, { mode: "llm" }])
    expect(() => readReviewResults(review, input)).toThrow();
  const before = JSON.stringify(review);
  readReviewResults(review, { statuses: ["stale"] });
  expect(JSON.stringify(review)).toBe(before);
});
