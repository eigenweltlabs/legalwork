import { z } from 'zod';
export const EXTRACTION_VERSION = 'local-text-v1';
export const EXTRACTION_LIMITS = { inputBytes: 8 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024, entryBytes: 4 * 1024 * 1024, entries: 1000, pages: 30, pixels: 4000000, outputBytes: 256 * 1024, wallMs: 90000, rssBytes: 768 * 1024 * 1024 };
export const extractionErrorSchema = z.enum(['unsupported', 'encrypted', 'malformed', 'limit', 'timeout', 'memory', 'cancelled', 'runtime_failed']);
export type ExtractionErrorCode = z.infer<typeof extractionErrorSchema>;
export class ExtractionError extends Error {
    constructor(readonly code: ExtractionErrorCode) { super('mail_extraction_' + code); }
}
export const extractedSectionSchema = z.object({ source: z.string().max(512), method: z.enum(['text', 'ocr']), text: z.string().max(EXTRACTION_LIMITS.outputBytes) }).strict();
export const extractedSchema = z.object({ version: z.literal(EXTRACTION_VERSION), sections: z.array(extractedSectionSchema).max(1000) }).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= EXTRACTION_LIMITS.outputBytes);
export type ExtractedText = z.infer<typeof extractedSchema>;
export const extractionInputSchema = z.object({ filename: z.string().max(4096), contentType: z.string().max(512), data: z.string().max(Math.ceil(EXTRACTION_LIMITS.inputBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict();
export type ExtractionInput = z.infer<typeof extractionInputSchema>;
