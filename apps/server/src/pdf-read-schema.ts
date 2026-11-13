import { z } from "zod";

export const PDF_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_ATTACHMENT_MAX_BYTES = 2_000_000;
export const PDF_READING_RECOVERY = "Choose a built-in PDF reading mode suited to the task: text, attach or ocr. If the first chosen mode fails or leaves a specific uncertainty relevant to the answer, such as missing page content or garbled, implausible or inconsistent information, use another applicable built-in PDF mode to resolve the affected content. Use shell only if the applicable built-in modes fail, are unavailable, or leave the relevant uncertainty unresolved. Stop once the information is clear and sufficient to answer.";
export const pdfReadOptions = z.object({
  attach: z.boolean().optional().describe("Send PDF pages directly to the model for visual inspection; default false. Requires a PDF-capable model. pages selects the actual pages attached; offset/limit do not affect attachments. Maximum 2 MB including base64 overhead. Can combine with text and/or ocr."),
  text: z.boolean().optional().describe("Extract embedded PDF text only; never runs OCR or attaches the PDF. Default true when neither attach nor ocr is requested, otherwise false. Pages without embedded text are reported so you can choose ocr=true or attach=true. Combine with ocr=true to return both text sources."),
  ocr: z.boolean().optional().describe("Explicitly recognize the selected pages, including scans, handwriting and visual additions; default false. Never runs automatically and never attaches a PDF. Use pages to bound OCR work (maximum 100 pages per call). Combine with text=true to retain embedded text too."),
  pages: z.array(z.number().int().min(1).max(1000)).min(1).max(1000).optional().describe("1-based source PDF page numbers for text extraction, OCR and/or attachment. Omit for all pages. This controls which pages are processed; offset/limit only paginate returned text."),
});
export const pdfTextResult = z.object({
  source_hash: z.string(), page_count: z.number(), extraction: z.enum(["native", "ocr"]),
  complete: z.boolean(),
  pages: z.array(z.object({ page: z.number(), text: z.string(), native_text: z.string().optional(), embedded_text_chars: z.number().int().min(0), extraction: z.enum(["native", "ocr"]), error: z.string().optional() })),
});
export type PdfTextResult = z.infer<typeof pdfTextResult>;
