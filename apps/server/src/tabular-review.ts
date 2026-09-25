import { z } from "zod";
import { SystemOneQuestionSchema, type SystemOneResponse } from "./systemone-schema.js";

export const ReviewRowArgs = z.object({
  backend: z.enum(["llm", "systemone"]).describe("Explicit backend from tabular_review_models. Never silently switch backends."),
  providerId: z.string().min(1),
  model: z.string().min(1),
  file: z.string().min(1).describe("Workspace-relative source path for the review artifact."),
  title: z.string().min(1),
  docType: z.string().default("unknown"),
  pages: z.array(z.object({
    page: z.number().int().positive().nullable().describe("1-based PDF page, or null for unpaginated text."),
    text: z.string().min(1),
  })).min(1).max(1000).describe("Complete extracted document text, never a summary. Use the bundled PDF/DOCX extractors first; no OCR is performed."),
  columns: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    question: z.string().min(1),
    hint: z.string().optional(),
    decision: SystemOneQuestionSchema.optional().describe("Required for SystemOne: explicit noul/choice/score instructions and criteria. Free-text columns require llm."),
  })).min(1).max(100),
}).superRefine((value, ctx) => {
  if (value.pages.reduce((sum, p) => sum + p.text.length, 0) > 500_000)
    ctx.addIssue({ code: "custom", message: "Document exceeds 500,000 characters; split it explicitly before reviewing." });
  if (new Set(value.columns.map((c) => c.key)).size !== value.columns.length)
    ctx.addIssue({ code: "custom", message: "Column keys must be unique." });
  if (value.backend === "systemone" && value.columns.some((c) => !c.decision))
    ctx.addIssue({ code: "custom", message: "SystemOne requires a typed decision for every column. Use llm for free-text extraction." });
});
export type ReviewRowInput = z.infer<typeof ReviewRowArgs>;

const LlmCells = z.object({
  cells: z.record(z.string(), z.object({
    value: z.string().min(1),
    reason: z.string(),
    quote: z.string(),
    page: z.number().int().positive().nullable(),
    location: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

export function parseReviewCells(input: ReviewRowInput, text: string) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  const result = LlmCells.parse(JSON.parse(fenced ? fenced[1] : text));
  if (JSON.stringify(Object.keys(result.cells).sort()) !== JSON.stringify(input.columns.map((c) => c.key).sort()))
    throw new Error("Review result must contain exactly the requested columns.");
  for (const cell of Object.values(result.cells)) {
    if (cell.value === "Not found") {
      if (cell.quote || cell.page !== null) throw new Error("Not found must not carry a citation.");
      continue;
    }
    if (!cell.quote || !input.pages.some((p) => p.page === cell.page && p.text.includes(cell.quote)))
      throw new Error("Review citation is missing or does not occur on the supplied source page.");
  }
  return result.cells;
}

export function decisionCells(response: SystemOneResponse) {
  return Object.fromEntries(Object.entries(response.answers).map(([key, answer]) => [key, {
    value: answer.type === "noul" ? `${(answer.noul * 100).toFixed(2)}% yes` : answer.type === "choice" ? answer.choice : String(Number(answer.score.toFixed(3))),
    reason: "SystemOne decision over the supplied document. The model does not return source citations or written reasoning; verify against the source.",
    quote: "", page: null, location: "", confidence: null,
    evidence: "uncited", decision: answer,
  }]));
}
