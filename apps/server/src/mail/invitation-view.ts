import { z } from "zod";
import { providerMessageLocatorSchema } from "./model.js";

export const mailInvitationInputSchema = z.object({
  locator: providerMessageLocatorSchema,
  partId: z.string().min(1).max(4096),
  referenceId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  rawReferenceId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
const invitationTimeSchema = z.object({
  value: z.string().max(40),
  kind: z.enum(["date", "utc", "zoned", "floating"]),
  timeZone: z.string().max(255).nullable(),
  instant: z.iso.datetime().nullable(),
}).strict();
export const mailInvitationSchema = z.object({
  uid: z.string().min(1).max(4096),
  method: z.string().max(40),
  sequence: z.number().int().nonnegative(),
  status: z.enum(["invitation", "update", "cancelled", "event"]),
  title: z.string().max(1000),
  description: z.string().max(20000),
  location: z.string().max(2000),
  organizer: z.string().max(1000).nullable(),
  attendees: z.array(z.string().max(1000)).max(200),
  start: invitationTimeSchema.nullable(),
  end: invitationTimeSchema.nullable(),
  recurrence: z.array(z.string().max(2000)).max(100),
  recurrenceId: invitationTimeSchema.nullable(),
  delegated: z.boolean(),
}).strict();
export const mailInvitationsSchema = z.object({ invitations: z.array(mailInvitationSchema).max(20) }).strict();
export type MailInvitationInput = z.infer<typeof mailInvitationInputSchema>;
export type MailInvitation = z.infer<typeof mailInvitationSchema>;
export type MailInvitationTime = z.infer<typeof invitationTimeSchema>;
