import { z } from 'zod';
import { providerMessageLocatorSchema } from './model.js';
import { extractionErrorSchema, EXTRACTION_VERSION } from './extraction/contract.js';
const id = z.string().min(1).max(4096), integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const extractionRequestSchema = z.object({ locator: providerMessageLocatorSchema, partId: id, referenceId: id }).strict();
export type MailExtractionRequest = z.infer<typeof extractionRequestSchema>;
export const extractionReadSchema = extractionRequestSchema.extend({ section: integer.default(0), offset: integer.default(0), limit: z.number().int().min(1).max(8192).default(4096) }).strict();
export type MailExtractionRead = z.input<typeof extractionReadSchema>;
export const extractionStatusSchema = z.object({ accountId: id, locator: providerMessageLocatorSchema, partId: id, referenceId: id, extractor: z.literal(EXTRACTION_VERSION), downloaded: z.boolean(), state: z.enum(['pending_download', 'queued', 'running', 'complete', 'failed']), attempts: integer, error: extractionErrorSchema.nullable(), sections: integer }).strict();
export type MailExtractionStatus = z.infer<typeof extractionStatusSchema>;
export const extractionTextSchema = z.object({ status: extractionStatusSchema, section: integer, offset: integer, source: z.string().max(512), method: z.enum(['text', 'ocr']), text: z.string().max(8192), nextOffset: integer.nullable(), nextSection: integer.nullable() }).strict();
export type MailExtractionText = z.infer<typeof extractionTextSchema>;
export const extractionCommandSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('mail.extraction.status'), accountId: id, input: extractionRequestSchema }).strict(),
    z.object({ operation: z.literal('mail.extraction.read'), accountId: id, input: extractionReadSchema }).strict(),
    z.object({ operation: z.literal('mail.extraction.reset'), accountId: id, input: extractionRequestSchema }).strict(),
]);
export type MailExtractionCommand = z.input<typeof extractionCommandSchema>;
