import { z } from "zod";
import { SystemOneAnswerSchema } from "./systemone.js";

export const ReviewModeSchema = z.enum(["jev", "mixed", "llm"]);
export const ReviewModelSchema = z.strictObject({ providerId: z.string().min(1), model: z.string().min(1) });
export const ReviewSettingsSchema = z.strictObject({
  mode: ReviewModeSchema,
  jev: ReviewModelSchema.nullable(),
  llm: ReviewModelSchema.nullable(),
});
export const ReviewColumnSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  label: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(8000),
  kind: z.enum(["yes_no", "classification", "text"]),
  options: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  hint: z.string().max(2000).default(""),
  libraryId: z.string().max(100).optional(),
  libraryVersion: z.number().int().positive().optional(),
  libraryColumnKey: z.string().max(80).optional(),
}).superRefine((column, ctx) => {
  if (column.kind === "classification" && (column.options.length < 2 || new Set(column.options).size !== column.options.length))
    ctx.addIssue({ code: "custom", message: "Classification requires 2–30 distinct, fixed answer options.", path: ["options"] });
  if (column.kind !== "classification" && column.options.length)
    ctx.addIssue({ code: "custom", message: "Only classification columns have answer options.", path: ["options"] });
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
  backend: z.enum(["llm", "systemone"]), providerId: z.string(), model: z.string(), requestedModel: z.string(),
  sourceHash: z.string(), prompt: ReviewColumnSchema, completedAt: z.number(),
  preparationPath: z.string().optional(),
  chunks: z.array(z.object({ index: z.number(), pages: z.array(z.number().nullable()), relevance: z.number().optional() })).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  deploymentRevision: z.string().optional(),
});
export const ReviewCellSchema = z.object({
  documentId: z.string(), columnKey: z.string(),
  status: z.enum(["pending", "running", "complete", "needs_review", "error", "stale"]),
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
  revision: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
  settings: ReviewSettingsSchema, columns: ReviewColumnsSchema,
  documents: z.array(ReviewDocumentSchema).max(100), cells: z.array(ReviewCellSchema),
  status: z.enum(["draft", "running", "complete", "needs_review", "cancelled", "interrupted"]),
  runId: z.string().uuid().nullable(), error: z.string().nullable().default(null),
});
export const CreateReviewSchema = z.strictObject({
  name: z.string().trim().min(1).max(180),
  files: z.array(z.string().min(1).max(4096)).min(1).max(100),
  columns: ReviewColumnsSchema,
  requestId: z.string().uuid(),
});
export const EditReviewSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(180).optional(),
  columns: ReviewColumnsSchema.optional(),
  files: z.array(z.string().min(1).max(4096)).min(1).max(100).optional(),
});
export const RunReviewSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  columnKeys: z.array(z.string()).min(1).optional(), documentIds: z.array(z.string()).min(1).optional(),
  rerun: z.boolean().default(false), reprocess: z.boolean().default(false),
});
export const ReviewLibraryEntrySchema = z.object({
  id: z.string(), version: z.number().int().positive(), name: z.string().trim().min(1).max(180),
  description: z.string().max(1500).default(""), tags: z.array(z.string().max(60)).max(12).default([]),
  language: z.enum(["en", "de"]), source: z.enum(["builtin", "personal"]),
  columns: ReviewColumnsSchema.refine(columns => columns.length > 0, "Include at least one column."), updatedAt: z.number(),
});
export const SaveReviewLibrarySchema = ReviewLibraryEntrySchema.pick({ name: true, description: true, tags: true, language: true, columns: true }).extend({
  id: z.string().uuid().optional(), version: z.number().int().positive().optional(),
});
export type ReviewMode = z.infer<typeof ReviewModeSchema>;
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;
export type ReviewColumn = z.infer<typeof ReviewColumnSchema>;
/** Reject explicit free-form deliverables mislabeled as a decision; execution still uses only fixed outputs. */
export function incompatibleJevQuestion(column: Pick<ReviewColumn, "kind" | "question" | "hint">) {
  if (column.kind === "text") return true;
  const text = `${column.question}\n${column.hint}`;
  return /(?:^|[.!?;\n]\s*)(?:please\s+)?(?:extract|list|summari[sz]e|describe|explain|draft|write|generate|provide\s+(?:an?\s+)?(?:explanation|summary|list)|return\s+(?:the\s+)?(?:exact|full|complete)\s+(?:text|wording|clause))\b/im.test(text)
    || /(?:^|[.!?;\n]\s*)(?:bitte\s+)?(?:extrahiere[n]?|liste[n]?|beschreibe[n]?|erkläre[n]?|begründe[n]?|formuliere[n]?|schreibe[n]?|fasse[n]?\s+.+zusammen)\b/im.test(text);
}
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewCell = z.infer<typeof ReviewCellSchema>;
export type ReviewDocument = z.infer<typeof ReviewDocumentSchema>;
export type SavedReview = z.infer<typeof SavedReviewSchema>;
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
