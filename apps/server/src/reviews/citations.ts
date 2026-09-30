import { z } from "zod";
import type { EvidencePage } from "./chunks.js";
import { quoteRange } from "../document-preparation/highlights.js";

export type ReviewEvidenceInput = { pages: EvidencePage[]; columns: Array<{ key: string; fallback?: { absent: string; uncertain: string } | null }> };

export class ReviewCitationError extends Error {}

/** Allow layout whitespace only; return the original source substring for the viewer. */
export function sourceQuote(text: string, quote: string) {
  const match = quoteRange(text, quote);
  return match ? text.slice(match.start, match.end) : null;
}

const LlmCells = z.object({
  cells: z.record(z.string(), z.object({
    value: z.string().min(1),
    reason: z.string(),
    quote: z.string(),
    page: z.number().int().positive().nullable(),
    // Section labels are optional; exact quotes and page references remain validated below.
    location: z.string().default(""),
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
  for (const [key, cell] of Object.entries(result.cells)) {
    const fallback = input.columns.find(column => column.key === key)?.fallback;
    if (fallback && cell.value === fallback.absent) cell.value = "Not found";
    if (fallback && cell.value === fallback.uncertain) cell.value = "Needs review";
    if (cell.value === "Not found" || cell.value === "Needs review") {
      // These are abstentions, not quoted findings. Models sometimes supply a
      // context passage anyway; discard it instead of failing the entire cell.
      cell.quote = ""; cell.page = null; cell.location = ""; cell.citations = []; cell.confidence = "low";
      if (cell.value === "Not found" && input.pages.some(page => page.status && page.status !== "complete")) {
        cell.value = "Needs review";
        cell.reason = "Document extraction is incomplete or uncertain; absence cannot be established.";
        cell.confidence = "low";
      }
      continue;
    }
    const primarySource = cell.citations?.[0]?.source;
    const primary = input.pages.filter(page => page.page === cell.page && (!primarySource || page.source === primarySource)).map(page => sourceQuote(page.text, cell.quote)).find(quote => quote !== null);
    if (!primary) throw new ReviewCitationError("Review citation is missing or does not occur on the supplied source page.");
    cell.quote = primary;
    if (cell.citations?.length) {
      for (const citation of cell.citations) {
        const page = input.pages.find(page => page.page === citation.page && page.source === citation.source && sourceQuote(page.text, citation.quote));
        const quote = page && sourceQuote(page.text, citation.quote);
        if (!page || !quote) throw new ReviewCitationError("Review citation does not match the prepared source.");
        citation.quote = quote;
        if (citation.regionIds?.length) {
          const regions = citation.regionIds.map(id => citation.source === "ocr" ? page.regions?.[id] : undefined);
          if (regions.some(region => !region) || !sourceQuote(regions.map(region => region?.text).join(" "), citation.quote))
            throw new ReviewCitationError("Review citation has invalid OCR regions.");
        }
        if (page.status && page.status !== "complete") cell.confidence = "low";
      }
      if (cell.quote !== cell.citations[0].quote || cell.page !== cell.citations[0].page)
        throw new ReviewCitationError("Primary citation must match the first citation.");
    } else if (input.pages.some(page => page.page === cell.page && page.text.includes(cell.quote) && page.status && page.status !== "complete")) {
      cell.confidence = "low";
    }
  }
  return result.cells;
}
