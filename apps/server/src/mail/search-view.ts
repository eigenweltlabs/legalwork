import { z } from "zod";
import { providerMessageLocatorSchema } from "./model.js";
const text = z.string().min(1).max(512), id = z.string().min(1).max(4096);
export const mailSearchInputSchema = z.object({
  keywords: z.array(text).max(20).optional(), phrase: text.optional(), literal: text.optional(),
  accountIds: z.array(id).min(1).max(100).optional(), sender: text.optional(), recipient: text.optional(),
  afterDate: z.string().datetime().optional(), beforeDate: z.string().datetime().optional(),
  folderId: id.optional(), unread: z.boolean().optional(), hasAttachment: z.boolean().optional(), filename: text.optional(),
  matterIdentifier: text.optional(),
  limit: z.number().int().min(1).max(25).optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(x => !x.afterDate || !x.beforeDate || x.afterDate < x.beforeDate);
export type MailSearchInput = z.infer<typeof mailSearchInputSchema>;
export const mailSearchResultSchema = z.object({
  items: z.array(z.object({accountId:id, locator:providerMessageLocatorSchema, subject:z.string().max(512), snippet:z.string().max(512), date:z.string().datetime().nullable(), hasAttachment:z.boolean().nullable(),attachmentMatches:z.array(z.object({partId:id,referenceId:id,section:z.number().int().nonnegative(),offset:z.number().int().nonnegative(),source:z.string().max(512)}).strict()).max(8).optional(),attachmentSources:z.array(z.object({partId:id,referenceId:id}).strict()).max(8).optional()}).strict()).max(25),
  total:z.number().int().nonnegative(), pending:z.number().int().nonnegative(), incomplete:z.number().int().nonnegative(), nextOffset:z.number().int().nonnegative().nullable(),
}).strict();
export type MailSearchResult = z.infer<typeof mailSearchResultSchema>;
export const mailSearchRebuildInputSchema = z.object({accountId:id, reset:z.boolean().optional(), limit:z.number().int().min(1).max(25).optional()}).strict();
export type MailSearchRebuildInput = z.infer<typeof mailSearchRebuildInputSchema>;
export const mailSearchRebuildResultSchema = z.object({processed:z.number().int().min(0).max(25),pending:z.number().int().nonnegative(),incomplete:z.number().int().nonnegative()}).strict();
export type MailSearchRebuildResult = z.infer<typeof mailSearchRebuildResultSchema>;
