import { z } from "zod";
import { SystemOneAnswerSchema } from "./systemone.js";

export const REVIEW_FILE_EXTENSIONS = ["pdf", "docx", "png", "jpg", "jpeg", "webp", "txt", "md", "markdown"];
export const REVIEW_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const REVIEW_MAX_DOCUMENTS = 100;
export function isReviewFile(name: string) {
  return name.includes(".") && REVIEW_FILE_EXTENSIONS.includes(name.split(".").at(-1)?.toLowerCase() ?? "");
}

export const ReviewModeSchema = z.enum(["jev", "mixed", "llm"]);
export const ReviewModelSchema = z.strictObject({ providerId: z.string().min(1), model: z.string().min(1) });
export const ReviewSettingsSchema = z.strictObject({
  mode: ReviewModeSchema,
  jev: ReviewModelSchema.nullable(),
  llm: ReviewModelSchema.nullable(),
  minDecisionProbability: z.number().min(0.5).max(1).optional(),
});
export const ReviewColumnKindSchema = z.enum(["yes_no", "classification", "text", "date", "number", "currency", "percentage", "multi_select"]);
export function isJevColumnKind(kind: string) { return kind === "yes_no" || kind === "classification"; }
export const ReviewColumnSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  label: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(8000),
  kind: ReviewColumnKindSchema,
  options: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  hint: z.string().max(2000).default(""),
  libraryId: z.string().max(100).optional(),
  libraryVersion: z.number().int().positive().optional(),
  libraryColumnKey: z.string().max(80).optional(),
}).superRefine((column, ctx) => {
  if ((column.kind === "classification" || column.kind === "multi_select") && (column.options.length < 2 || new Set(column.options).size !== column.options.length))
    ctx.addIssue({ code: "custom", message: "Classification requires 2–30 distinct, fixed answer options.", path: ["options"] });
  if (column.kind !== "classification" && column.kind !== "multi_select" && column.options.length)
    ctx.addIssue({ code: "custom", message: "Only choice columns have answer options.", path: ["options"] });
});
export const ReviewColumnsSchema = z.array(ReviewColumnSchema).max(60).refine(
  columns => new Set(columns.map(column => column.key)).size === columns.length, "Column keys must be unique.",
);
export const ReviewCitationSchema = z.object({
  page: z.number().int().positive().nullable(), quote: z.string(),
  source: z.enum(["native", "ocr"]).optional(), regionIds: z.array(z.number().int().nonnegative()).optional(),
});
export const ReviewResultSchema = z.object({
  value: z.string(), reason: z.string(), citations: z.array(ReviewCitationSchema),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  evidence: z.enum(["cited", "uncited", "absent", "uncertain"]),
  decision: SystemOneAnswerSchema.optional(),
  decisionThreshold: z.number().min(0.5).max(1).optional(),
  backend: z.enum(["llm", "systemone"]), providerId: z.string(), model: z.string(), requestedModel: z.string(),
  sourceHash: z.string(), prompt: ReviewColumnSchema, completedAt: z.number(),
  preparationPath: z.string().optional(),
  chunks: z.array(z.object({ index: z.number(), pages: z.array(z.number().nullable()), relevance: z.number().optional() })).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  deploymentRevision: z.string().optional(),
});
export const ReviewCellSchema = z.object({
  documentId: z.string(), columnKey: z.string(),
  status: z.enum(["pending", "queued", "running", "blocked", "complete", "needs_review", "error", "stale"]),
  blockedBy: z.enum(["llm", "systemone", "jev_mode"]).optional(),
  result: ReviewResultSchema.nullable().default(null), error: z.string().nullable().default(null),
});
export const ReviewDocumentSchema = z.object({
  id: z.string(), path: z.string(), name: z.string(), sourceHash: z.string().nullable(),
  status: z.enum(["pending", "preparing", "ready", "needs_review", "error"]),
  completedPages: z.number().default(0), pageCount: z.number().default(0),
  preparationPath: z.string().optional(), error: z.string().nullable().default(null),
});
export const SavedReviewSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(180),
  sessionId: z.string().min(1).max(200).nullable().optional(),
  sessionCreatedForReview: z.boolean().optional(),
  revision: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
  settings: ReviewSettingsSchema, columns: ReviewColumnsSchema,
  documents: z.array(ReviewDocumentSchema).max(REVIEW_MAX_DOCUMENTS), cells: z.array(ReviewCellSchema),
  status: z.enum(["draft", "running", "complete", "needs_review", "cancelled", "interrupted"]),
  runId: z.string().uuid().nullable(), error: z.string().nullable().default(null),
});
export const CreateReviewSchema = z.strictObject({
  name: z.string().trim().min(1).max(180),
  files: z.array(z.string().min(1).max(4096)).max(REVIEW_MAX_DOCUMENTS),
  columns: ReviewColumnsSchema,
  requestId: z.string().uuid(),
  sessionId: z.string().min(1).max(200).optional(),
});
export const EditReviewSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(180).optional(),
  columns: ReviewColumnsSchema.optional(),
  files: z.array(z.string().min(1).max(4096)).max(REVIEW_MAX_DOCUMENTS).optional(),
});
export const RunReviewSchema = z.strictObject({
  sessionId: z.string().min(1).max(200).optional(),
  revision: z.number().int().nonnegative(),
  columnKeys: z.array(z.string()).min(1).optional(), documentIds: z.array(z.string()).min(1).optional(),
  rerun: z.boolean().default(false), reprocess: z.boolean().default(false),
  retryFailed: z.boolean().optional(),
});
export const ReadReviewResultsSchema = z.strictObject({
  revision: z.number().int().nonnegative().optional(),
  documentIds: z.array(z.string().min(1)).min(1).max(REVIEW_MAX_DOCUMENTS).optional(),
  columnKeys: z.array(z.string().min(1)).min(1).max(60).optional(),
  statuses: z.array(ReviewCellSchema.shape.status).min(1).max(8).optional(),
  values: z.array(z.string().min(1).max(2000)).min(1).max(30).optional(),
  query: z.string().trim().min(1).max(300).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
/** Agent queries use a latest snapshot initially and opaque cursors thereafter. */
export const QueryReviewResultsSchema = z.strictObject({
  cursor: z.string().max(200).optional().describe("Continue with the returned nextCursor; omit every other query option."),
  view: z.enum(["overview", "answers", "evidence"]).optional().describe("Default overview: full-scope counts and distributions. answers: matching cells. evidence: exact quotes, explanations and every outcome probability."),
  documentIds: z.array(z.string().min(1).max(160)).min(1).max(REVIEW_MAX_DOCUMENTS).optional(),
  columnKeys: z.array(z.string().min(1).max(80)).min(1).max(60).optional(),
  statuses: z.array(ReviewCellSchema.shape.status).min(1).max(8).optional(),
  evidence: z.array(ReviewResultSchema.shape.evidence).min(1).max(4).optional(),
  values: z.array(z.string().min(1).max(2000)).min(1).max(30).optional().describe("Exact accepted answers only; stale and uncertain results cannot match."),
  query: z.string().trim().min(1).max(300).optional().describe("Case-insensitive literal text search."),
  searchIn: z.array(z.enum(["answer", "reason", "citations", "document", "column"])).min(1).max(5).optional(),
  valueFilter: z.strictObject({
    operator: z.enum(["eq", "gt", "gte", "lt", "lte"]),
    value: z.union([z.number().finite(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  }).optional().describe("Requires exactly one date, number, percentage or currency column. Percentages use percentage points, e.g. 12.5 means 12.5%."),
  currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("ISO currency, required for currency comparisons and value sorting. No currency conversion."),
  sort: z.strictObject({ by: z.enum(["document", "column", "value", "status"]), direction: z.enum(["asc", "desc"]) }).optional().describe("Value sorting requires exactly one column and uses its actual data type; unavailable values stay last."),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum records per page, default 100. The server also enforces a response byte budget."),
});
export type QueryReviewResults = z.infer<typeof QueryReviewResultsSchema>;
export const ReviewLibraryKindSchema = z.enum(["prompt", "set"]);
export const ReviewLibraryEntrySchema = z.object({
  kind: ReviewLibraryKindSchema.optional(),
  id: z.string(), version: z.number().int().positive(), name: z.string().trim().min(1).max(180),
  description: z.string().max(1500).default(""), tags: z.array(z.string().max(60)).max(12).default([]),
  language: z.enum(["en", "de"]), source: z.enum(["builtin", "personal"]),
  columns: ReviewColumnsSchema.refine(columns => columns.length > 0, "Include at least one column."), updatedAt: z.number(),
});
export const SaveReviewLibrarySchema = ReviewLibraryEntrySchema.pick({ name: true, description: true, tags: true, language: true, columns: true, kind: true }).extend({
  id: z.string().uuid().optional(), version: z.number().int().positive().optional(),
});
export type ReviewMode = z.infer<typeof ReviewModeSchema>;
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;
export const DEFAULT_REVIEW_DECISION_THRESHOLD = 0.8;
export function reviewDecisionThreshold(settings: ReviewSettings) {
  return settings.minDecisionProbability ?? DEFAULT_REVIEW_DECISION_THRESHOLD;
}
export function reviewDecisionProbabilities(decision: z.infer<typeof SystemOneAnswerSchema>) {
  if (decision.type === "noul") return [{ label: "Yes", probability: decision.noul }, { label: "No", probability: 1 - decision.noul }];
  return Object.entries(decision.probabilities).map(([key, probability]) => ({ label: decision.type === "score" ? decision.legend[key] : key, probability }));
}
export function selectedReviewDecisionProbability(decision: z.infer<typeof SystemOneAnswerSchema>) {
  if (decision.type === "noul") return Math.max(decision.noul, 1 - decision.noul);
  return decision.probabilities[decision.type === "choice" ? decision.choice : String(decision.score)] ?? 0;
}
export type ReviewColumn = z.infer<typeof ReviewColumnSchema>;
/** Reject explicit free-form deliverables mislabeled as a decision; execution still uses only fixed outputs. */
export function incompatibleJevQuestion(column: Pick<ReviewColumn, "kind" | "question" | "hint">) {
  if (!isJevColumnKind(column.kind)) return true;
  const text = `${column.question}\n${column.hint}`;
  return /(?:^|[.!?;\n]\s*)(?:please\s+)?(?:extract|list|summari[sz]e|describe|explain|draft|write|generate|provide\s+(?:an?\s+)?(?:explanation|summary|list)|return\s+(?:the\s+)?(?:exact|full|complete)\s+(?:text|wording|clause))\b/im.test(text)
    || /(?:^|[.!?;\n]\s*)(?:bitte\s+)?(?:extrahiere[n]?|liste[n]?|beschreibe[n]?|erkläre[n]?|begründe[n]?|formuliere[n]?|schreibe[n]?|fasse[n]?\s+.+zusammen)\b/im.test(text);
}
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewCell = z.infer<typeof ReviewCellSchema>;
export type ReviewDocument = z.infer<typeof ReviewDocumentSchema>;
export type SavedReview = z.infer<typeof SavedReviewSchema>;
export type ReviewUpdate =
  | { type: "full"; review: SavedReview }
  | { type: "unchanged"; revision: number }
  | { type: "patch"; baseRevision: number; revision: number; metadata: Partial<Omit<SavedReview, "cells">>; cells: ReviewCell[]; removed: string[] };
export const reviewCellKey = (cell: Pick<ReviewCell, "documentId" | "columnKey">) => `${cell.documentId}:${cell.columnKey}`;
export function applyReviewUpdate(previous: SavedReview | undefined, update: ReviewUpdate): SavedReview | undefined {
  if (update.type === "full") return update.review;
  if (update.type === "unchanged") return previous?.revision === update.revision ? previous : undefined;
  if (!previous || previous.revision !== update.baseRevision) return undefined;
  const changed = new Map(update.cells.map(cell => [reviewCellKey(cell), cell]));
  const removed = new Set(update.removed);
  const cells = previous.cells.filter(cell => !removed.has(reviewCellKey(cell))).map(cell => {
    const key = reviewCellKey(cell), next = changed.get(key);
    changed.delete(key);
    return next ?? cell;
  });
  cells.push(...changed.values());
  return { ...previous, ...update.metadata, revision: update.revision, cells };
}
export function reviewRunAction(review: SavedReview) {
  if (review.status === "running") return "stop";
  const unfinished = review.cells.some(cell => ["pending", "queued", "running", "stale", "blocked"].includes(cell.status)
    && !(review.settings.mode === "jev" && review.columns.some(column => column.key === cell.columnKey && incompatibleJevQuestion(column))));
  if (!unfinished && review.cells.some(cell => cell.status === "error")) return "retry_failed";
  return !review.cells.length || unfinished ? review.runId ? "resume" : "run" : "rerun_all";
}
export type ReviewLibraryEntry = z.infer<typeof ReviewLibraryEntrySchema>;
export type CreateReview = z.infer<typeof CreateReviewSchema>;
export type EditReview = z.infer<typeof EditReviewSchema>;
export type RunReview = z.infer<typeof RunReviewSchema>;
export type SaveReviewLibrary = z.infer<typeof SaveReviewLibrarySchema>;
export type ReviewModel = z.infer<typeof ReviewModelSchema>;
export type ReviewSourceReference = { reviewId: string; documentId: string; columnKey: string; citationIndex: number; completedAt: number };
export type ReviewSourcePage = {
  name: string; path: string; page: number; pageCount: number; quote: string;
  image: string; width: number; height: number;
  regions: Array<{ x: number; y: number; width: number; height: number }>;
};
export type ReviewCapabilities = {
  settings: ReviewSettings;
  models: Array<ReviewModel & { name: string; providerName: string; backend: "llm" | "systemone"; contextTokens?: number }>;
  allowedKinds: ReviewColumn["kind"][];
  errors: string[];
};
export type ReviewSummary = Pick<SavedReview, "id" | "name" | "revision" | "status" | "createdAt" | "updatedAt" | "settings" | "error"> & {
  documents: number; columns: number; completed: number; total: number;
};

export const ReviewToolCardSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), review: z.object({
  id: z.string().uuid(), name: z.string(), status: z.string(), completed: z.number(), total: z.number(), documents: z.number(), columns: z.number(),
}) });

/** Older library entries predate explicit kinds; keep their saved data readable. */
export function reviewLibraryKind(entry: Pick<ReviewLibraryEntry, "kind" | "columns">): "prompt" | "set" {
  return entry.kind ?? (entry.columns.length === 1 ? "prompt" : "set");
}
/** All prompts includes columns in sets, deduplicated by their exact definition. */
export function reviewLibraryPrompts(entries: ReviewLibraryEntry[]) {
  type Prompt = { id: string; entry: ReviewLibraryEntry; column: ReviewColumn; sets: ReviewLibraryEntry[] };
  const prompts: Prompt[] = [], definitions = new Map<string, Prompt>();
  for (const entry of [...entries].sort((a, b) => Number(reviewLibraryKind(a) === "set") - Number(reviewLibraryKind(b) === "set"))) {
    for (const column of entry.columns) {
      const key = JSON.stringify([entry.source, entry.language, column.label, column.question, column.kind, column.options, column.hint]);
      const set = reviewLibraryKind(entry) === "set";
      let item = set ? definitions.get(key) : undefined;
      if (!item) { item = { id: `${entry.id}:${column.key}`, entry, column, sets: [] }; prompts.push(item); definitions.set(key, item); }
      if (set && !item.sets.some(parent => parent.id === entry.id)) item.sets.push(entry);
    }
  }
  return prompts;
}
