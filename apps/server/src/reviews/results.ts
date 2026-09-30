import { ApiError } from "../errors.js";
import { ReadReviewResultsSchema, reviewDecisionProbabilities, type ReviewCell, type SavedReview } from "./schema.js";

export function statusCounts(cells: ReviewCell[]) {
  return {
    complete: cells.filter(cell => cell.status === "complete").length,
    needsReview: cells.filter(cell => cell.status === "needs_review").length,
    error: cells.filter(cell => cell.status === "error").length,
    blocked: cells.filter(cell => cell.status === "blocked").length,
    stale: cells.filter(cell => cell.status === "stale").length,
    pending: cells.filter(cell => cell.status === "pending").length,
    queued: cells.filter(cell => cell.status === "queued").length,
    running: cells.filter(cell => cell.status === "running").length,
  };
}

/** Project-scoped saved results only: no model calls, reruns or source re-extraction. */
export function readReviewResults(review: SavedReview, raw: unknown) {
  const input = ReadReviewResultsSchema.parse(raw);
  if (input.revision !== undefined && input.revision !== review.revision)
    throw new ApiError(409, "review_results_changed", "The review changed between result pages. Read again from offset 0 before combining results.", { revision: review.revision });
  if (input.documentIds?.some(id => !review.documents.some(document => document.id === id))
    || input.columnKeys?.some(key => !review.columns.some(column => column.key === key)))
    throw new ApiError(400, "review_selection", "The selected documents or columns do not belong to this review.");

  const documents = new Map(review.documents.map(document => [document.id, document]));
  const columns = new Map(review.columns.map(column => [column.key, column]));
  const query = input.query?.toLocaleLowerCase();
  const matches = review.cells.filter(cell => {
    if (input.documentIds && !input.documentIds.includes(cell.documentId)) return false;
    if (input.columnKeys && !input.columnKeys.includes(cell.columnKey)) return false;
    if (input.statuses && !input.statuses.includes(cell.status)) return false;
    // Value filters describe current accepted answers, never retained stale results.
    if (input.values && (cell.status !== "complete" || !cell.result || cell.result.evidence === "uncertain" || !input.values.includes(cell.result.value))) return false;
    return !query || [documents.get(cell.documentId)?.name, columns.get(cell.columnKey)?.label, columns.get(cell.columnKey)?.question,
      cell.result?.value, cell.result?.reason, ...cell.result?.citations.map(citation => citation.quote) ?? []]
      .some(value => value?.toLocaleLowerCase().includes(query));
  });
  const page = matches.slice(input.offset, input.offset + input.limit);
  const includedColumns = review.columns.filter(column => !input.columnKeys || input.columnKeys.includes(column.key));
  const includedDocuments = review.documents.filter(document => !input.documentIds || input.documentIds.includes(document.id));

  return {
    review: { id: review.id, name: review.name, revision: review.revision, status: review.status, mode: review.settings.mode, updatedAt: review.updatedAt, error: review.error },
    scope: { ...input, sourceFilesRevalidated: false },
    summary: {
      totalCells: review.cells.length, matchingCells: matches.length, allStatuses: statusCounts(review.cells), matchingStatuses: statusCounts(matches),
      columns: includedColumns.map(column => {
        const cells = matches.filter(cell => cell.columnKey === column.key);
        const values = new Map<string, number>();
        // Fixed decisions have useful bounded distributions; arbitrary extracted
        // text stays in the paginated cells instead of ballooning the summary.
        if (column.kind === "yes_no" || column.kind === "classification") for (const cell of cells) {
          if (cell.status !== "complete" || !cell.result || cell.result.evidence === "uncertain") continue;
          values.set(cell.result.value, (values.get(cell.result.value) ?? 0) + 1);
        }
        return { key: column.key, label: column.label, kind: column.kind, statuses: statusCounts(cells), answers: [...values].map(([value, count]) => ({ value, count })) };
      }),
    },
    documents: includedDocuments.map(document => ({ id: document.id, name: document.name, path: document.path, status: document.status, error: document.error })),
    columns: includedColumns.map(column => ({ key: column.key, label: column.label, kind: column.kind, question: column.question, options: column.options })),
    cells: page.map(cell => ({
      documentId: cell.documentId, documentName: documents.get(cell.documentId)?.name,
      columnKey: cell.columnKey, columnLabel: columns.get(cell.columnKey)?.label,
      status: cell.status, blockedBy: cell.blockedBy, error: cell.error,
      usableAnswer: cell.status === "complete" && !!cell.result && cell.result.evidence !== "uncertain",
      result: cell.result ? {
        value: cell.result.value, reason: cell.result.reason, evidence: cell.result.evidence, confidence: cell.result.confidence,
        probabilities: cell.result.decision ? reviewDecisionProbabilities(cell.result.decision) : [],
        decisionThreshold: cell.result.decisionThreshold, citations: cell.result.citations,
        questionUsed: { question: cell.result.prompt.question, kind: cell.result.prompt.kind, options: cell.result.prompt.options },
        backend: cell.result.backend, providerId: cell.result.providerId, model: cell.result.model,
        sourceHash: cell.result.sourceHash, completedAt: cell.result.completedAt,
      } : null,
    })),
    offset: input.offset, returnedCells: page.length,
    nextOffset: input.offset + page.length < matches.length ? input.offset + page.length : null,
  };
}
