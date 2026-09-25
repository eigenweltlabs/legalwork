import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { preparedSchema } from "./document-preparation/schema.js";
import { z } from "zod";
import { SystemOneQuestionSchema, type SystemOneResponse } from "./systemone-schema.js";

export const ReviewRowArgs = z.object({
  backend: z.enum(["llm", "systemone"]).describe("Explicit backend from tabular_review_models. Never silently switch backends."),
  providerId: z.string().min(1),
  model: z.string().min(1),
  file: z.string().min(1).describe("Workspace-relative source path for the review artifact."),
  title: z.string().min(1),
  docType: z.string().default("unknown"),
  preparationPath: z.string().min(1).optional().describe("Workspace-relative preparationPath from legalwork_document_prepare for PDF/images. Omit pages; the tool validates and loads the original evidence."),
  pages: z.array(z.object({
    page: z.number().int().positive().nullable().describe("1-based PDF page, or null for unpaginated text."),
    text: z.string(),
    source: z.enum(["native", "ocr"]).optional(),
    status: z.enum(["complete", "needs-review", "error"]).optional(),
    regions: z.array(z.object({ text: z.string() })).optional(),
  })).max(2000).default([]).describe("Complete DOCX/text content, never a summary. For PDF/images supply preparationPath instead."),
  columns: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    question: z.string().min(1),
    hint: z.string().optional(),
    decision: SystemOneQuestionSchema.optional().describe("Required for SystemOne: explicit noul/choice/score instructions and criteria. Free-text columns require llm."),
  })).min(1).max(100),
}).superRefine((value, ctx) => {
  if (!value.preparationPath && !value.pages.some(page => page.text.trim()))
    ctx.addIssue({ code: "custom", message: "Supply complete source text or a document preparationPath." });
  if (value.preparationPath && value.pages.length)
    ctx.addIssue({ code: "custom", message: "Supply preparationPath or pages, not both." });
  if (value.pages.reduce((sum, p) => sum + p.text.length, 0) > 500_000)
    ctx.addIssue({ code: "custom", message: "Document exceeds 500,000 characters; split it explicitly before reviewing." });
  if (new Set(value.columns.map((c) => c.key)).size !== value.columns.length)
    ctx.addIssue({ code: "custom", message: "Column keys must be unique." });
  if (value.backend === "systemone" && value.columns.some((c) => !c.decision))
    ctx.addIssue({ code: "custom", message: "SystemOne requires a typed decision for every column. Use llm for free-text extraction." });
});
export type ReviewRowInput = z.infer<typeof ReviewRowArgs>;

/** Prepared files and source documents must stay inside the current workspace. */
export async function loadReviewEvidence(input: ReviewRowInput, directory: string): Promise<ReviewRowInput> {
  if (!input.preparationPath) return input;
  const root = await realpath(directory);
  async function localPath(path: string) {
    const target = await realpath(resolve(root, path));
    const part = relative(root, target);
    if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
      throw new Error("Review evidence must be inside the workspace.");
    return target;
  }
  const preparation = await localPath(input.preparationPath);
  if ((await stat(preparation)).size > 128 * 1024 * 1024) throw new Error("Prepared evidence is too large.");
  const prepared = preparedSchema.parse(JSON.parse(await readFile(preparation, "utf8")));
  const source = await localPath(input.file);
  if (source !== await localPath(prepared.fileAbs) || (await stat(source)).size > 64 * 1024 * 1024)
    throw new Error("Preparation does not match the review document.");
  if (createHash("sha256").update(await readFile(source)).digest("hex") !== prepared.sourceSha256)
    throw new Error("Source changed since preparation. Prepare the document again.");
  const complete = prepared.status === "complete" && prepared.pageCount > 0 &&
    prepared.pages.length === prepared.pageCount && prepared.pages.every(page => page.status === "complete");
  if (!complete && input.backend === "systemone")
    throw new Error("Document preparation is incomplete or uncertain. Resolve the OCR issues before running SystemOne decisions.");
  const pages: ReviewRowInput["pages"] = prepared.pages.flatMap(page => [
    { page: page.page, text: page.nativeText, source: "native", status: page.status },
    { page: page.page, text: page.ocr?.text ?? "", source: "ocr", status: page.status, regions: page.ocr?.regions.map(region => ({ text: region.text })) },
  ]);
  if (!complete && pages.every(page => page.status === "complete"))
    pages.push({ page: null, text: "", status: "error" });
  // Reapply the document size bound after loading, before either backend sees text.
  const validated = ReviewRowArgs.parse({ ...input, preparationPath: undefined, pages });
  return { ...validated, preparationPath: input.preparationPath };
}

const LlmCells = z.object({
  cells: z.record(z.string(), z.object({
    value: z.string().min(1),
    reason: z.string(),
    quote: z.string(),
    page: z.number().int().positive().nullable(),
    location: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    citations: z.array(z.object({
      page: z.number().int().positive(), quote: z.string().min(1),
      source: z.enum(["native", "ocr"]), regionIds: z.array(z.number().int().nonnegative()).optional(),
    })).optional(),
  })),
});

export function parseReviewCells(input: ReviewRowInput, text: string) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  const result = LlmCells.parse(JSON.parse(fenced ? fenced[1] : text));
  if (JSON.stringify(Object.keys(result.cells).sort()) !== JSON.stringify(input.columns.map((c) => c.key).sort()))
    throw new Error("Review result must contain exactly the requested columns.");
  for (const cell of Object.values(result.cells)) {
    if (cell.value === "Not found" || cell.value === "Needs review") {
      if (cell.quote || cell.page !== null || cell.citations?.length) throw new Error("Absence or uncertainty must not carry a citation.");
      if (cell.value === "Not found" && input.pages.some(page => page.status && page.status !== "complete")) {
        cell.value = "Needs review";
        cell.reason = "Document extraction is incomplete or uncertain; absence cannot be established.";
        cell.confidence = "low";
      }
      continue;
    }
    if (!cell.quote || !input.pages.some((p) => p.page === cell.page && p.text.includes(cell.quote)))
      throw new Error("Review citation is missing or does not occur on the supplied source page.");
    if (cell.citations?.length) {
      for (const citation of cell.citations) {
        const page = input.pages.find(page => page.page === citation.page && page.source === citation.source && page.text.includes(citation.quote));
        if (!page) throw new Error("Review citation does not match the prepared source.");
        if (citation.regionIds?.length) {
          const regions = citation.regionIds.map(id => citation.source === "ocr" ? page.regions?.[id] : undefined);
          if (regions.some(region => !region) || !regions.map(region => region?.text).join(" ").includes(citation.quote))
            throw new Error("Review citation has invalid OCR regions.");
        }
        if (page.status && page.status !== "complete") cell.confidence = "low";
      }
      if (cell.quote !== cell.citations[0].quote || cell.page !== cell.citations[0].page)
        throw new Error("Primary citation must match the first citation.");
    } else if (input.pages.some(page => page.page === cell.page && page.text.includes(cell.quote) && page.status && page.status !== "complete")) {
      cell.confidence = "low";
    }
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
