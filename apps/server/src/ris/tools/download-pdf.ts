import { z } from "zod";
import type { RisClient } from "../client/ris-client.js";
import { classifyId, contentUrlFor, convertBody, normaliseIdInput, parseDocHeader } from "../client/content.js";
import { RisValidationError } from "../infrastructure/errors.js";
import { ApplikationEnum } from "../schemas/enums.js";
import { RisCitationLeanSchema } from "../schemas/citation.js";
import { minimalCitation } from "./get-section.js";

const inputSchema = z.object({
  id: z.string().min(6).max(2048).describe("Exact RIS document number or official document URL from ris_search. For a complete judgment choose its Entscheidungstext (JWT_/JJT_), not a Rechtssatz (JWR_/JJR_). For legislation choose the exact section/version document ID."),
  applikation: ApplikationEnum.describe("The database returned by the RIS search, for example Vwgh, Justiz, BrKons or LrKons."),
  filename: z.string().min(5).max(160).refine(name => !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name)
    && !/^[. ]/.test(name) && /\.pdf$/i.test(name) && Buffer.byteLength(name) <= 200
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name), "Use a portable .pdf filename without folders.").optional(),
}).strict();

const savedPdfSchema = z.object({
  path: z.string(), relativePath: z.string(), filename: z.string(),
  mimeType: z.literal("application/pdf"), size: z.number().int().positive(),
});

export type SaveRisPdf = (document: { html: string; sourceUrl: string; title: string; filename: string }) => Promise<z.infer<typeof savedPdfSchema>>;

export function buildDownloadPdfTool(client: RisClient, savePdf?: SaveRisPdf) {
  return {
    description: "Download a PDF rendered from the complete original RIS HTML into the current project's Downloads folder, the same location as browser downloads. Requires the desktop PDF renderer and a project chat. Does not open a browser tab or summarize/rewrite the source. Returns the saved path and RIS citation, never file data. This is a generated reading copy, not RIS's original or digitally signed PDF. Existing files are preserved with a numbered filename. Use this action to preserve RIS primary sources for legal research instead of browser navigation, shell downloads or agent-written PDFs.",
    inputSchema,
    outputSchema: savedPdfSchema.extend({
      sourceUrl: z.string().url(), generatedFrom: z.literal("original_ris_html"), ris_citation: RisCitationLeanSchema,
    }),
    handler: async (input: z.infer<typeof inputSchema>) => {
      if (!savePdf) throw new Error("RIS PDF downloads require the desktop PDF renderer and a project chat.");
      const id = normaliseIdInput(input.id);
      if (classifyId(id) !== "dokumentnummer") throw new RisValidationError("Search RIS first and pass an exact decision or section document number to download its PDF.");
      const sourceUrl = contentUrlFor(input.applikation, id);
      const { html } = await client.fetchHtml(sourceUrl);
      const plain = await convertBody(html, "plain", client.signal);
      if (!plain.trim()) throw new RisValidationError("RIS returned an empty document. No PDF was saved.");
      const citation = minimalCitation(input.applikation, id, parseDocHeader(plain));
      client.signal.throwIfAborted();
      const saved = await savePdf({ html, sourceUrl, title: citation.citation_label, filename: input.filename ?? `${id}.pdf` });
      return { ...saved, sourceUrl, generatedFrom: "original_ris_html", ris_citation: citation };
    },
  };
}
