import { z } from "zod";
import type { EvidencePage } from "./chunks.js";

export type ReviewEvidenceInput = { pages: EvidencePage[]; columns: Array<{ key: string }> };

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

export function parseReviewCells(input: ReviewEvidenceInput, text: string) {
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
