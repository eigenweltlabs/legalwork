import { z } from "zod";
import { connectorMailDraftTargetSchema, connectorDraftDeliverySchema } from "./connectors.js";

const header = z.string().max(2000).refine(value => !/[\r\n\u0000]/.test(value), "Email headers must be a single line.");
export const EmailDraftInputSchema = z.object({
  from: header.default(""),
  replyTo: header.default(""),
  to: header.default(""),
  cc: header.default(""),
  bcc: header.default(""),
  subject: header.default(""),
  body: z.string().max(500000).default(""),
  html: z.string().max(500000).default(""),
  attachments: z.array(z.object({
    path: z.string().min(1).max(1000),
    name: header.max(255).optional(),
    contentType: z.string().max(100).regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/).default("application/octet-stream"),
  })).max(20).default([]),
});
export type EmailDraftInput = z.infer<typeof EmailDraftInputSchema>;
export const EmailDraftAccountSchema = z.enum(["auto", "local", "gmail", "outlook"]);
export const EmailDraftCreateInputSchema = EmailDraftInputSchema.extend({
  account: EmailDraftAccountSchema.default("auto").describe("Use auto to select the sole connected email account, or ask the user if several are connected. Use gmail or outlook when the user chooses that account. Use local only when the user explicitly requests an unconnected draft."),
});
export const EmailDraftSchema = EmailDraftInputSchema.extend({
  id: z.uuid(), workspaceId: z.string(), revision: z.uuid(),
  path: z.string(), updatedAt: z.number(),
  connectorTarget: connectorMailDraftTargetSchema.optional(), delivery: connectorDraftDeliverySchema.optional(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

/** Split mailbox lists without treating commas in quoted names or addresses as separators. */
export function emailMailboxes(value: string): string[] {
  const mailboxes: string[] = [];
  let start = 0, quoted = false, escaped = false, commentDepth = 0, angleDepth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && (quoted || commentDepth > 0)) { escaped = true; continue; }
    if (character === '"' && commentDepth === 0) { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "(") commentDepth++;
    else if (character === ")" && commentDepth > 0) commentDepth--;
    else if (commentDepth === 0) {
      if (character === "<") angleDepth++;
      else if (character === ">" && angleDepth > 0) angleDepth--;
      else if (character === "," && angleDepth === 0) { mailboxes.push(value.slice(start, index).trim()); start = index + 1; }
    }
  }
  mailboxes.push(value.slice(start).trim());
  return mailboxes.filter(Boolean);
}

/** mailto recipients use addr-spec, without a display name. */
export function emailAddressSpecs(value: string): string[] {
  return emailMailboxes(value).map(mailbox => /<([^<>]+)>\s*$/.exec(mailbox)?.[1].trim() ?? mailbox);
}
