import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ApiError } from "../errors.js";
import { QueryReviewResultsSchema, reviewDecisionProbabilities, type QueryReviewResults, type SavedReview } from "./schema.js";
import { comparableValue, queryCells, usableAnswer } from "./result-query.js";
import { statusCounts } from "./results.js";

export const RESULT_QUERY_PAGE_BYTES = 24_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_TTL = 15 * 60_000;
const excerpt = (text: string, length = 600) => text.length > length ? { text: text.slice(0, length), truncated: true } : { text, truncated: false };

/** Preserve every character of long answers/quotes in bounded, ordered records. */
function* textParts(text: string) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 3000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield { text: text.slice(offset, end), offset, totalCharacters: text.length, complete: end === text.length };
    offset = end;
  }
}

function* queryRecords(review: SavedReview, input: QueryReviewResults, matches: ReturnType<typeof queryCells>) {
  const view = input.view ?? "overview";
  if (view === "overview") {
    for (const column of review.columns) {
      if (input.columnKeys && !input.columnKeys.includes(column.key)) continue;
      const cells = matches.cells.filter(cell => cell.columnKey === column.key);
      const values = new Map<string, number>();
      const ranges = new Map<string, { count: number; min: string | number; max: string | number }>();
      for (const cell of cells) {
        if (!usableAnswer(cell) || !cell.result) continue;
        if (column.kind === "yes_no" || column.kind === "classification") values.set(cell.result.value, (values.get(cell.result.value) ?? 0) + 1);
        if (["date", "number", "percentage", "currency"].includes(column.kind)) {
          const parsed = comparableValue(cell, column);
          if (!parsed) continue;
          const unit = parsed.currency ?? column.kind, range = ranges.get(unit);
          if (!range) ranges.set(unit, { count: 1, min: parsed.value, max: parsed.value });
          else { range.count++; if (parsed.value < range.min) range.min = parsed.value; if (parsed.value > range.max) range.max = parsed.value; }
        }
      }
      yield { type: "column", columnKey: column.key, label: column.label, kind: column.kind, matchingCells: cells.length, statuses: statusCounts(cells),
        ranges: [...ranges].map(([unit, range]) => ({ unit, ...range })),
        ...(column.kind === "text" || column.kind === "multi_select" ? { note: "Read the answers view for substantive findings; counts cannot summarize free text." } : {}) };
      for (const [value, count] of [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        const preview = excerpt(value);
        yield { type: "distribution", columnKey: column.key, value: preview.text, valueTruncated: preview.truncated, count };
      }
    }
    return;
  }
  for (const cell of matches.cells) {
    const ref = { documentId: cell.documentId, columnKey: cell.columnKey };
    const result = cell.result, value = result ? excerpt(result.value) : null;
    yield { type: "answer", ...ref, documentName: matches.documents.get(cell.documentId)?.name, columnLabel: matches.columns.get(cell.columnKey)?.label,
      status: cell.status, usableAnswer: usableAnswer(cell), value: value?.text ?? null, valueTruncated: value?.truncated ?? false, evidence: result?.evidence,
      ...(cell.blockedBy ? { blockedBy: cell.blockedBy } : {}), ...(cell.error ? { error: excerpt(cell.error).text, errorTruncated: cell.error.length > 600 } : {}) };
    if (view !== "evidence") continue;
    if (cell.error && cell.error.length > 600) for (const part of textParts(cell.error)) yield { type: "error_text", ...ref, ...part };
    if (!result) continue;
    if (value?.truncated) for (const part of textParts(result.value)) yield { type: "answer_text", ...ref, ...part };
    for (const part of textParts(result.reason)) yield { type: "reason", ...ref, ...part };
    const probabilities = result.decision ? reviewDecisionProbabilities(result.decision) : [];
    for (let offset = 0; offset < probabilities.length; offset += 5)
      yield { type: "probabilities", ...ref, outcomes: probabilities.slice(offset, offset + 5), offset, totalOutcomes: probabilities.length, decisionThreshold: result.decisionThreshold };
    for (const [citationIndex, citation] of result.citations.entries()) for (const part of textParts(citation.quote))
      yield { type: "citation", ...ref, citationIndex, page: citation.page, source: citation.source, ...part };
    yield { type: "provenance", ...ref, backend: result.backend, providerId: result.providerId, model: result.model, sourceHash: result.sourceHash, completedAt: result.completedAt };
    for (const part of textParts(result.prompt.question)) yield { type: "question", ...ref, ...part };
  }
}

function snapshotData(review: SavedReview, input: QueryReviewResults, now: number) {
  const matches = queryCells(review, input);
  const records: string[] = [];
  let bytes = 0;
  for (const record of queryRecords(review, input, matches)) {
    const encoded = JSON.stringify(record), size = Buffer.byteLength(encoded);
    if (size > RESULT_QUERY_PAGE_BYTES - 3000 || bytes + size > MAX_SNAPSHOT_BYTES)
      throw new ApiError(413, "review_results_scope_too_large", "Select fewer documents or columns to read this evidence.");
    records.push(encoded); bytes += size;
  }
  const accepted = matches.cells.filter(usableAnswer);
  const metadata = {
    review: { id: review.id, name: review.name, revision: review.revision, status: review.status, mode: review.settings.mode, updatedAt: review.updatedAt },
    scope: { view: input.view ?? "overview", sourceFilesRevalidated: false, snapshotCreatedAt: now, summaryCoversAllMatches: true },
    summary: { totalCells: review.cells.length, matchingCells: matches.cells.length, matchingDocuments: new Set(matches.cells.map(cell => cell.documentId)).size,
      allStatuses: statusCounts(review.cells), matchingStatuses: statusCounts(matches.cells), acceptedAnswers: accepted.length,
      absentAnswers: accepted.filter(cell => cell.result?.evidence === "absent").length },
    guidance: (input.view ?? "overview") === "overview"
      ? "Distributions cover all matching accepted answers. Preserve each answer label and count exactly: No, Not found, Not applicable and uncertainty have different meanings. Not found is a valid result, not automatically a risk or missing contractual protection. For document-specific findings use view=answers with filters; for quotations and all probabilities use view=evidence. Follow nextCursor to finish this view; do not use shell commands or read internal files."
      : "Only usableAnswer=true records are accepted findings. Read value, not the usableAnswer flag, as the answer. Truncated answer previews are available in full in view=evidence. Follow nextCursor with reviewId only; do not change filters or assume a partial page is the whole review.",
  };
  return { records, metadata, bytes, limit: input.limit ?? 100 };
}
type Snapshot = ReturnType<typeof snapshotData> & { scope: string; reviewId: string; expiresAt: number };

/** Short-lived bounded snapshots: later pages never silently mix revisions. */
export class ReviewResultQueries {
  private secret = randomBytes(32);
  private snapshots = new Map<string, Snapshot>();
  constructor(private now = () => Date.now()) {}
  forget(scope: string, reviewId: string) {
    for (const [id, snapshot] of this.snapshots) if (snapshot.scope === scope && snapshot.reviewId === reviewId) this.snapshots.delete(id);
  }
  private signature(payload: string) { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  private cursor(id: string, offset: number) { const payload = `${id}.${offset}`; return `${payload}.${this.signature(payload)}`; }
  private expire() {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.snapshots.delete(id);
  }
  async read(scope: string, reviewId: string, raw: unknown, load: () => Promise<SavedReview>) {
    const input = QueryReviewResultsSchema.parse(raw);
    this.expire();
    let id: string, offset = 0, snapshot: Snapshot;
    if (input.cursor) {
      if (Object.entries(input).some(([key, value]) => key !== "cursor" && value !== undefined))
        throw new ApiError(400, "review_results_cursor", "A continuation needs only reviewId and cursor; its filters and view are already saved.");
      const parts = input.cursor.split(".");
      const expected = this.signature(`${parts[0]}.${parts[1]}`), supplied = parts[2] ?? "";
      if (parts.length !== 3 || !/^\d+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)))
        throw new ApiError(400, "review_results_cursor", "Invalid results cursor. Start a new results query.");
      id = parts[0]; offset = Number(parts[1]);
      const saved = this.snapshots.get(id);
      if (!saved || saved.scope !== scope || saved.reviewId !== reviewId)
        throw new ApiError(410, "review_results_expired", "This results snapshot expired or is unavailable. Start a new query without a cursor; do not combine it with earlier pages.");
      snapshot = saved;
    } else {
      id = randomUUID();
      snapshot = { ...snapshotData(await load(), input, this.now()), scope, reviewId, expiresAt: this.now() + SNAPSHOT_TTL };
    }
    const items: unknown[] = [];
    const response = () => ({ ...snapshot.metadata, items,
      coverage: { totalRecords: snapshot.records.length, recordsBefore: offset, returnedRecords: items.length, complete: offset + items.length >= snapshot.records.length },
      nextCursor: offset + items.length < snapshot.records.length ? this.cursor(id, offset + items.length) : null });
    for (let index = offset; index < snapshot.records.length && items.length < snapshot.limit; index++) {
      items.push(JSON.parse(snapshot.records[index]));
      if (Buffer.byteLength(JSON.stringify(response())) > RESULT_QUERY_PAGE_BYTES) { items.pop(); break; }
    }
    if (!items.length && offset < snapshot.records.length) throw new ApiError(413, "review_results_scope_too_large", "Select fewer documents or columns to read this evidence.");
    const output = response();
    if (output.nextCursor && !input.cursor) {
      let bytes = [...this.snapshots.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [oldId, old] of this.snapshots) {
        if (this.snapshots.size < 20 && bytes + snapshot.bytes <= MAX_SNAPSHOT_BYTES) break;
        this.snapshots.delete(oldId); bytes -= old.bytes;
      }
      this.snapshots.set(id, snapshot);
    }
    return output;
  }
}
