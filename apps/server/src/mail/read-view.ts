import { z } from "zod";
import { providerMessageKey, providerMessageLocatorSchema } from "./model.js";
import { mimeMetadataSchema } from "./storage/mime-projection-store.js";

const id = z.string().min(1).max(4096);
const key = z.string().min(1).max(32768);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mailMessagePageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50), after: key.optional(),
  folderId: id.optional(), threadId: id.optional(), includeRemoved: z.boolean().default(false),
}).strict();
export type MailMessagePageInput = z.input<typeof mailMessagePageSchema>;
export const mailMessageViewSchema = z.object({
  accountId: id, key, locator: providerMessageLocatorSchema, subject: z.string(),
  threadId: id.nullable(), rfcMessageId: z.string().nullable(), removed: z.boolean(),
  memberships: z.array(id).max(10000),
  contentState: z.enum(["complete", "downloading", "attention"]),
  metadata: mimeMetadataSchema.nullable(),
}).strict().refine(value => value.key === providerMessageKey(value.locator));
export type MailMessageView = z.infer<typeof mailMessageViewSchema>;
export const mailMessageListSchema = z.object({
  accountId: id, items: z.array(mailMessageViewSchema).max(100), nextCursor: key.nullable(),
}).strict();
export const mailPartPageSchema = z.object({ limit: z.number().int().min(1).max(100).default(50), after: key.optional() }).strict();
export type MailPartPageInput = z.input<typeof mailPartPageSchema>;
export const mailPartViewSchema = z.object({
  key, kind: z.enum(["raw", "body", "attachment"]), partId: z.string().max(4096),
  state: z.enum(["stored", "pending", "unavailable"]),
  referenceId: id.nullable(), bytes: integer.nullable(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  bytesAvailable: z.boolean(), filename: z.string().nullable(), contentType: z.string().nullable(), contentId: z.string().nullable(),
}).strict();
export const mailPartListSchema = z.object({ accountId: id, locator: providerMessageLocatorSchema, items: z.array(mailPartViewSchema).max(100), nextCursor: key.nullable() }).strict();
export type MailPartView = z.infer<typeof mailPartViewSchema>;
export const mailContentReadSchema = z.object({
  kind: z.enum(["raw", "body", "attachment"]), partId: z.string().max(4096).default(""),
  referenceId: id, offset: integer.default(0), limit: z.number().int().min(1).max(24576).default(24576),
}).strict().refine(value => (value.kind === "attachment") === (value.partId.length > 0));
export type MailContentReadInput = z.input<typeof mailContentReadSchema>;
export const mailContentChunkSchema = z.object({
  accountId: id, locator: providerMessageLocatorSchema, referenceId: id, offset: integer,
  totalBytes: integer, sha256: z.string().regex(/^[0-9a-f]{64}$/), data: z.string().max(32768).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  nextOffset: integer.nullable(),
}).strict().refine(value => {
  const size = Buffer.from(value.data, "base64").byteLength;
  return value.data === Buffer.from(value.data, "base64").toString("base64")
    && value.referenceId === `sha256:${value.sha256}`
    && value.offset + size === (value.nextOffset ?? value.totalBytes)
    && (value.nextOffset === null ? value.offset <= value.totalBytes : size > 0 && value.nextOffset < value.totalBytes);
});
export type MailContentChunk = z.infer<typeof mailContentChunkSchema>;
