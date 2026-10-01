import type { SavedReview } from "@legalwork/types/reviews";

const csv = (rows: string[][]) => rows.map(row => row.map(value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(",")).join("\r\n") + "\r\n";

/** Export stored answers, never model-written reconstructions or resolutions. */
export function reviewExportData(review: SavedReview) {
  const cells = new Map(review.cells.map(cell => [`${cell.documentId}\0${cell.columnKey}`, cell]));
  const documents = new Map(review.documents.map(document => [document.id, document]));
  const statuses: Record<string, number> = {};
  for (const cell of review.cells) statuses[cell.status] = (statuses[cell.status] ?? 0) + 1;
  const header = ["document_id", "document", "source_hash", ...review.columns.flatMap(column => [`${column.key} (${column.label})`, `${column.key}_status`])];
  const grid = csv([header, ...review.documents.map(document => [document.id, document.path, document.sourceHash ?? "", ...review.columns.flatMap(column => {
    const cell = cells.get(`${document.id}\0${column.key}`);
    return [cell?.result?.value ?? "", cell?.status ?? "pending"];
  })])]);
  const unresolved = review.cells.filter(cell => cell.status !== "complete");
  const exceptions = csv([["review_id", "revision", "document_id", "document", "column", "value", "status", "error"], ...unresolved.map(cell => [review.id, String(review.revision), cell.documentId, documents.get(cell.documentId)?.path ?? "", cell.columnKey, cell.result?.value ?? "", cell.status, cell.error ?? ""])]);
  const manifest = JSON.stringify({ reviewId: review.id, name: review.name, revision: review.revision, status: review.status,
    settings: review.settings, columns: review.columns, documents: review.documents.map(({ id, path, sourceHash, status, pageCount, error }) => ({ id, path, sourceHash, status, pageCount, error })),
    cellStatuses: statuses, unresolvedCells: unresolved.length, guidance: "An exported exception remains unresolved. Source inspection and a separate per-cell disposition with verified evidence are required; export does not clear it." }, null, 2);
  return { grid, exceptions, manifest, statuses, unresolvedCells: unresolved.length };
}
