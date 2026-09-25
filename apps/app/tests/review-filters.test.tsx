import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedReviewSchema } from "@legalwork/types/reviews";
import { emptyReviewFilters, reviewFilterQuery } from "../src/react-app/domains/reviews/review-filters";
import { ReviewGrid } from "../src/react-app/domains/reviews/review-grid";

const review = SavedReviewSchema.parse({ id: "f09b7dc5-643b-4888-b660-38e05fe50b78", name: "Review", revision: 0, createdAt: 1, updatedAt: 1,
  settings: { mode: "llm", jev: null, llm: { providerId: "test", model: "test" } }, status: "complete", runId: null,
  columns: ["number", "date", "currency", "classification"].map(kind => ({ key: kind, kind, label: kind, question: "Question", options: kind === "classification" ? ["Yes", "No", "Not found"] : [] })), documents: [], cells: [],
});
test("table filter requests use typed numeric/date comparisons and explicit currency", () => {
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "number", operator: "gte", value: "0", sort: "value" }).input).toMatchObject({ columnKeys: ["number"], valueFilter: { operator: "gte", value: 0 }, sort: { by: "value", direction: "asc" } });
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "date", operator: "lt", value: "2026-09-25" }).input?.valueFilter).toEqual({ operator: "lt", value: "2026-09-25" });
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "currency", sort: "value" }).error).toBe("review.filter_currency_required");
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "currency", operator: "gt", value: "100", currency: "EUR" }).input).toMatchObject({ currency: "EUR", valueFilter: { value: 100 } });
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "number", operator: "eq", value: "" }).error).toBe("review.filter_value_required");
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "number", operator: "eq", value: "bad" }).error).toBe("review.filter_invalid");
});
test("absence, accepted choices, attention and literal search stay distinct", () => {
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, status: "absent" }).input).toMatchObject({ evidence: ["absent"], statuses: ["complete"] });
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "classification", answer: "Not found", search: "  consent  " }).input).toMatchObject({ values: ["Not found"], query: "consent" });
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, status: "attention" }).input?.statuses).toEqual(["blocked", "needs_review", "error", "stale"]);
  expect(reviewFilterQuery(review, { ...emptyReviewFilters, column: "deleted", sort: "value" }).input).toMatchObject({ sort: { by: "document", direction: "asc" } });
});
test("large review tables mount a bounded window while retaining total row/column accessibility counts", () => {
  const large = { ...review,
    columns: Array.from({ length: 60 }, (_, index) => ({ ...review.columns[0], key: `q${index}`, label: `Question ${index}` })),
    documents: Array.from({ length: 100 }, (_, index) => ({ id: `d${index}`, name: `Document ${index}`, path: `${index}.txt`, status: "ready", sourceHash: null, completedPages: 0, pageCount: 0 } satisfies typeof review.documents[number])),
    cells: Array.from({ length: 6000 }, (_, index) => ({ documentId: `d${Math.floor(index / 60)}`, columnKey: `q${index % 60}`, status: "pending", result: null, error: null } satisfies typeof review.cells[number])),
  };
  const noop = () => {};
  const html = renderToStaticMarkup(<ReviewGrid review={large} onSelect={noop} onEdit={noop} onSave={noop} onColumns={noop} onAdd={noop} busy={false} selectedDocuments={[]} onSelectDocuments={noop} />);
  expect(html).toContain('aria-rowcount="101"'); expect(html).toContain('aria-colcount="62"');
  const mountedCells = (html.match(/data-review-column=/g) ?? []).length;
  expect(mountedCells).toBeGreaterThan(0);
  expect(mountedCells).toBeLessThan(300);
  expect(html).not.toContain('aria-label="Document 99: Question 59"');
});
