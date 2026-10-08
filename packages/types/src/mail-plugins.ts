import { z } from "zod";

export const mailProviderSchema = z.enum(["gmail", "outlook"]);
export type MailProvider = z.infer<typeof mailProviderSchema>;
export const mailAccountIdSchema = z.string().min(1).max(256);
export const mailMessageIdSchema = z.string().min(1).max(1024);
export const mailAddressSchema = z.email().max(320);
export const mailOutgoingSchema = z.object({
  to: z.array(mailAddressSchema).min(1).max(50),
  cc: z.array(mailAddressSchema).max(50).default([]),
  bcc: z.array(mailAddressSchema).max(50).default([]),
  subject: z.string().max(998).refine((value) => !/[\r\n\x00]/.test(value), "Invalid subject"),
  body: z.string().max(50_000),
}).strict();
export type MailOutgoing = z.infer<typeof mailOutgoingSchema>;
export const mailAccountSchema = z.object({
  id: mailAccountIdSchema,
  provider: mailProviderSchema,
  email: z.string(),
  name: z.string(),
  canWrite: z.boolean(),
  connectedAt: z.string(),
  workspaceAccess: z.boolean().optional(),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;
export const mailPluginStatusSchema = z.object({
  provider: mailProviderSchema,
  configured: z.boolean(),
  connected: z.boolean(),
  accounts: z.array(mailAccountSchema),
});
export type MailPluginStatus = z.infer<typeof mailPluginStatusSchema>;
export const mailConnectStartSchema = z.object({ flowId: z.string(), authUrl: z.url(), expiresAt: z.number() });
export const mailConnectStatusSchema = z.object({
  status: z.enum(["pending", "connected", "failed", "expired", "cancelled"]),
  error: z.string().nullable(),
});
export type MailConnectStart = z.infer<typeof mailConnectStartSchema>;
export type MailConnectStatus = z.infer<typeof mailConnectStatusSchema>;
export const mailSearchSchema = z.object({ query: z.string().trim().min(1).max(2048), limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(16_384).optional() }).strict();
export const mailActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), accountId: mailAccountIdSchema, ...mailSearchSchema.shape }).strict(),
  z.object({ action: z.literal("read"), accountId: mailAccountIdSchema, messageId: mailMessageIdSchema }).strict(),
  z.object({ action: z.literal("attachment"), accountId: mailAccountIdSchema, messageId: mailMessageIdSchema, attachmentId: mailMessageIdSchema }).strict(),
  z.object({ action: z.literal("draft"), accountId: mailAccountIdSchema, ...mailOutgoingSchema.shape }).strict(),
  z.object({ action: z.literal("reply_draft"), accountId: mailAccountIdSchema, messageId: mailMessageIdSchema, body: z.string().max(50_000), replyAll: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("send"), accountId: mailAccountIdSchema, requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/), ...mailOutgoingSchema.shape }).strict(),
]);
export type MailAction = z.infer<typeof mailActionSchema>;
