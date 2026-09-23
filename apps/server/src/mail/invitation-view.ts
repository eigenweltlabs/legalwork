import { z } from "zod";
import { providerMessageLocatorSchema } from "./model.js";

export const invitationSourceSchema = z
  .object({
    locator: providerMessageLocatorSchema,
    partId: z.string().min(1).max(4096),
    referenceId: z
      .string()
      .max(100)
      .regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const invitationResponseSchema = z.enum([
  "accepted",
  "tentative",
  "declined",
]);
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;
export const invitationTimeSchema = z.object({
  value: z.string(),
  label: z.string(),
  kind: z.enum(["date", "utc", "zoned", "floating"]),
  timeZone: z.string().nullable(),
});
export const invitationSchema = z.object({
  uid: z.string(),
  sequence: z.number(),
  method: z.string(),
  status: z.string(),
  summary: z.string(),
  description: z.string(),
  location: z.string(),
  organizer: z.string().nullable(),
  attendees: z.array(z.string()),
  start: invitationTimeSchema,
  end: invitationTimeSchema.nullable(),
  recurrence: z.array(z.string()),
  recurrenceId: z.string().nullable(),
  responseLimit: z.string().nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationsSchema = z.object({
  invitations: z.array(invitationSchema),
});
export const invitationPreviewSchema = z.object({
  token: z.string().nullable(),
  account: z.string().nullable(),
  invitation: invitationSchema,
  currentResponse: z.string().nullable(),
  calendarStart: z.string().nullable(),
  calendarEnd: z.string().nullable(),
  notice: z.string().nullable(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
export const invitationResultSchema = z.object({
  outcome: z.enum(["updated", "unchanged", "uncertain"]),
  message: z.string(),
});
export type InvitationResult = z.infer<typeof invitationResultSchema>;
