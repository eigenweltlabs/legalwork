import { expect, test } from "bun:test";
import { SavedReviewSchema } from "@legalwork/types/reviews";
import { reviewExportData } from "./review-export.js";

test("exports 5,000 agreements and 40,000 actual cells without losing statuses or quoting", () => {
  const columns = Array.from({ length: 8 }, (_, i) => ({ key: `column-${i}`, label: `Question ${i}`, question: "Does X apply?", kind: "classification", options: ["Yes", "No"], libraryId: "installed", libraryVersion: 2, libraryColumnKey: `column-${i}` }));
  const review = SavedReviewSchema.parse({ id: "eae18172-80c0-40a7-b59b-c4ef79054436", name: "Whole class", revision: 9, createdAt: 0, updatedAt: 1, settings: { mode: "jev", jev: null, llm: null }, status: "needs_review", runId: null, columns,
    documents: Array.from({ length: 5000 }, (_, i) => ({ id: `doc-${i}`, path: `room/${i}.pdf`, name: `${i}.pdf`, sourceHash: `hash-${i}`, status: "ready" })),
    cells: Array.from({ length: 5000 }, (_, i) => columns.map(column => ({ documentId: `doc-${i}`, columnKey: column.key, status: i === 0 ? "needs_review" : "complete", result: { value: i === 0 ? 'Unclear, "source"\nneeded' : "Yes", reason: "", citations: [], confidence: null, evidence: "uncited", backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: `hash-${i}`, prompt: column, completedAt: 1 } }))).flat() });
  const data = reviewExportData(review);
  expect(data.statuses).toEqual({ needs_review: 8, complete: 39992 });
  expect(data.unresolvedCells).toBe(8);
  expect(data.grid).toContain('"Unclear, ""source""\nneeded",needs_review');
  expect(data.grid).toContain("doc-4999,room/4999.pdf,hash-4999");
  expect(data.exceptions).toContain("doc-0,room/0.pdf,column-7");
  expect(data.exceptions).not.toContain("doc-1,");
  expect(JSON.parse(data.manifest).columns).toEqual(review.columns);
  expect(JSON.stringify(review.cells[0])).toContain("needs_review");
});
