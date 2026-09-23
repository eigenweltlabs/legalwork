import { z } from "zod";
import { mailAddressSchema } from "./local-view.js";
const id = z.string().min(1).max(4096);
export const CONTACT_SCOPES = {
  gmail: "https://www.googleapis.com/auth/contacts.readonly",
  graph: "Contacts.Read",
};
export const contactsInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("sync") }).strict(),
  z.object({ action: z.literal("disable") }).strict(),
  z
    .object({ action: z.literal("search"), query: z.string().max(256) })
    .strict(),
]);
export type ContactsInput = z.infer<typeof contactsInputSchema>;
export const contactSuggestionSchema = z
  .object({
    address: mailAddressSchema,
    name: z.string().max(256),
    source: z.literal("personal"),
  })
  .strict();
export const contactsResultSchema = z
  .object({
    accountId: id,
    enabled: z.boolean(),
    state: z.enum(["disabled", "ready", "syncing", "error", "unsupported"]),
    count: z.number().int().nonnegative(),
    lastSyncAt: z.number().int().nonnegative().nullable(),
    error: z
      .enum(["permission", "unavailable", "limit", "invalid_response"])
      .nullable(),
    items: z.array(contactSuggestionSchema).max(30),
  })
  .strict();
export type ContactsResult = z.infer<typeof contactsResultSchema>;
export type ContactSuggestion = z.infer<typeof contactSuggestionSchema>;
