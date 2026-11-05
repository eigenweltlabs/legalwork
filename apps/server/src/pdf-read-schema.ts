import { z } from "zod";

export const PDF_MAX_BYTES = 64 * 1024 * 1024;
export const pdfReadOptions = z.object({
  ocr: z.boolean().optional().describe("Request OCR even when embedded PDF text exists. Use when explicitly asked or visual additions need recognition."),
  pages: z.array(z.number().int().min(1).max(1000)).min(1).max(1000).optional().describe("Optional 1-based PDF page numbers to read or OCR."),
});
export const pdfTextResult = z.object({
  source_hash: z.string(), page_count: z.number(), extraction: z.enum(["native", "ocr"]),
  complete: z.boolean(),
  pages: z.array(z.object({ page: z.number(), text: z.string(), extraction: z.enum(["native", "ocr"]), error: z.string().optional() })),
});
export type PdfTextResult = z.infer<typeof pdfTextResult>;
