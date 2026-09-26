import { z } from "zod";
import { ApiError } from "../errors.js";
import type { QueryReviewResults, ReviewCell, ReviewColumn, SavedReview } from "./schema.js";
import { validateColumnValue } from "./value-types.js";

export function usableAnswer(cell: ReviewCell) {
  return cell.status === "complete" && !!cell.result && cell.result.evidence !== "uncertain";
}

const money = z.object({ amount: z.number().finite(), currency: z.string().regex(/^[A-Z]{3}$/) });
export function comparableValue(cell: ReviewCell, column: ReviewColumn): { value: number | string; currency?: string } | null {
  if (!usableAnswer(cell) || !cell.result || cell.result.evidence === "absent") return null;
  const value = cell.result.value;
  if (value === "Not found" || value === "Needs review") return null;
  try {
    validateColumnValue(column, value);
    if (column.kind === "currency") {
      const parsed = money.parse(JSON.parse(value));
      return { value: parsed.amount, currency: parsed.currency };
    }
    if (column.kind === "number" || column.kind === "percentage") return { value: Number(value) };
    return { value };
  } catch { return null; }
}

export function queryCells(review: SavedReview, input: QueryReviewResults) {
  const documents = new Map(review.documents.map(document => [document.id, document]));
  const columns = new Map(review.columns.map(column => [column.key, column]));
  const invalid = (message: string): never => { throw new ApiError(400, "review_results_query", message); };
  if (input.documentIds?.some(id => !documents.has(id)) || input.columnKeys?.some(key => !columns.has(key)))
    invalid("The selected documents or columns do not belong to this review.");
  const column = input.columnKeys?.length === 1 ? columns.get(input.columnKeys[0]) : undefined;
  if (input.valueFilter || input.sort?.by === "value" || input.currency) {
    if (!column) invalid("Select exactly one column for value comparisons, currency filtering or value sorting.");
    else {
      if (input.currency && column.kind !== "currency") invalid("Currency filtering requires a currency column.");
      if (column.kind === "currency" && !input.currency) invalid("Specify an ISO currency for comparisons or sorting; amounts in different currencies cannot be compared.");
      if (input.valueFilter) {
        if (!["date", "number", "percentage", "currency"].includes(column.kind)) invalid("Value comparisons require a date, number, percentage or currency column.");
        if (column.kind === "date") {
          if (typeof input.valueFilter.value !== "string") invalid("Compare dates using YYYY-MM-DD.");
          try { validateColumnValue(column, String(input.valueFilter.value)); } catch { invalid("Use a valid comparison date (YYYY-MM-DD)."); }
        } else if (typeof input.valueFilter.value !== "number") invalid("Compare amounts, numbers and percentages using a numeric value.");
      }
    }
  }
  const query = input.query?.toLowerCase();
  const searchIn = input.searchIn ?? ["answer", "reason", "citations", "document"];
  const cells = review.cells.filter(cell => {
    if (input.documentIds && !input.documentIds.includes(cell.documentId)) return false;
    if (input.columnKeys && !input.columnKeys.includes(cell.columnKey)) return false;
    if (input.statuses && !input.statuses.includes(cell.status)) return false;
    if (input.evidence && (!cell.result || !input.evidence.includes(cell.result.evidence))) return false;
    if (input.values && (!usableAnswer(cell) || !cell.result || !input.values.includes(cell.result.value))) return false;
    if (column && (input.valueFilter || input.currency)) {
      const parsed = comparableValue(cell, column);
      if (!parsed || (input.currency && parsed.currency !== input.currency)) return false;
      if (input.valueFilter) {
        const { operator, value } = input.valueFilter;
        if (typeof parsed.value !== typeof value) return false;
        if (!(operator === "eq" ? parsed.value === value : operator === "gt" ? parsed.value > value : operator === "gte" ? parsed.value >= value : operator === "lt" ? parsed.value < value : parsed.value <= value)) return false;
      }
    }
    if (!query) return true;
    const fields = searchIn.flatMap(field => {
      if (field === "document") return [documents.get(cell.documentId)?.name];
      if (field === "column") return [columns.get(cell.columnKey)?.label];
      if (field === "answer") return [cell.result?.value];
      if (field === "reason") return [cell.result?.reason];
      return cell.result?.citations.map(citation => citation.quote) ?? [];
    });
    return fields.some(value => value?.toLowerCase().includes(query));
  });
  const sort = input.sort ?? { by: "document", direction: "asc" };
  const compare = (a: string | number, b: string | number) => typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  cells.sort((a, b) => {
    let order: number;
    if (sort.by === "value" && column) {
      const av = comparableValue(a, column), bv = comparableValue(b, column);
      if (!av || !bv) return av ? -1 : bv ? 1 : a.documentId.localeCompare(b.documentId);
      order = compare(av.value, bv.value);
    } else {
      const key = (cell: ReviewCell) => sort.by === "status" ? cell.status : sort.by === "column" ? columns.get(cell.columnKey)?.label ?? "" : documents.get(cell.documentId)?.name ?? "";
      order = compare(key(a), key(b));
    }
    return (sort.direction === "desc" ? -order : order) || a.documentId.localeCompare(b.documentId) || a.columnKey.localeCompare(b.columnKey);
  });
  return { cells, documents, columns };
}
