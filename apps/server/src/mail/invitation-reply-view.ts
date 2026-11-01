import { z } from "zod";
import { mailInvitationInputSchema, invitationTimeSchema } from "./invitation-view.js";

const id = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const invitationResponseSchema = z.enum(["accepted", "tentative", "declined"]);
export const invitationReplySelectionSchema = z.object({
  connectorId: z.enum(["google-calendar", "outlook-calendar"]), connectionId: id, calendarId: id,
}).strict();
export const invitationCalendarSchema = invitationReplySelectionSchema.extend({ name: z.string().max(1024), account: z.string().max(320), canWrite: z.boolean() }).strict();
export const invitationCalendarsSchema = z.object({ calendars: z.array(invitationCalendarSchema).max(1000), unavailable: z.array(z.enum(["google-calendar", "outlook-calendar"])).max(2) }).strict();
export const invitationReplyPreviewInputSchema = z.object({ source: mailInvitationInputSchema, index: z.number().int().min(0).max(19), calendar: invitationReplySelectionSchema, response: invitationResponseSchema }).strict();
export const invitationReplyConfirmInputSchema = z.object({ token: digest }).strict();
export const invitationReplyEventSchema = z.object({
  id, uid: id, revision: digest, title: z.string().max(1000), description: z.string().max(20000), descriptionType: z.enum(["text", "html"]),
  organizer: z.email().max(320), replyAs: z.email().max(320), location: z.string().max(2000),
  start: invitationTimeSchema, end: invitationTimeSchema, scope: z.enum(["event", "series", "occurrence"]),
  currentResponse: invitationResponseSchema.nullable(), webUrl: z.string().max(8192).nullable(),
}).strict();
export const invitationReplyPreviewSchema = z.object({
  token: digest.nullable(), expiresAt: z.number().int().nonnegative(), calendar: invitationCalendarSchema,
  event: invitationReplyEventSchema, response: invitationResponseSchema, status: z.enum(["ready", "unchanged", "pending"]), changedSinceInvitation: z.boolean(),
}).strict();
export const invitationReplyResultSchema = z.object({ outcome: z.enum(["confirmed", "unchanged", "uncertain", "rejected"]), response: invitationResponseSchema }).strict();
export const invitationReplyErrorSchema = z.enum(["changed", "cancelled", "not_invitation", "not_found", "ambiguous", "permission", "account_changed", "unsupported_time", "pending", "expired", "unavailable"]);
export class InvitationReplyError extends Error {
  constructor(readonly code: z.infer<typeof invitationReplyErrorSchema>) { super(`mail_invitation_${code}`); }
}

export const invitationReplyJournalInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), key: digest }).strict(),
  z.object({ action: z.literal("begin"), key: digest, attemptId: z.uuid(), response: invitationResponseSchema }).strict(),
  z.object({ action: z.literal("finish"), key: digest, attemptId: z.uuid(), state: z.enum(["confirmed", "rejected"]) }).strict(),
]);
export const invitationReplyJournalEntrySchema = z.object({
  key: digest, attemptId: z.uuid(), response: invitationResponseSchema,
  state: z.enum(["uncertain", "confirmed", "rejected"]), updatedAt: z.number().int().nonnegative(),
}).strict();
export const invitationReplyJournalResultSchema = z.object({ accountId: id, entry: invitationReplyJournalEntrySchema.nullable(), claimed: z.boolean() }).strict();
export const invitationReplyJournalCommandSchema = z.object({ operation: z.literal("mail.invitation.journal"), accountId: id, input: invitationReplyJournalInputSchema }).strict();
export type InvitationReplySelection = z.infer<typeof invitationReplySelectionSchema>;
export type InvitationCalendar = z.infer<typeof invitationCalendarSchema>;
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;
export type InvitationReplyPreviewInput = z.infer<typeof invitationReplyPreviewInputSchema>;
export type InvitationReplyJournalInput = z.infer<typeof invitationReplyJournalInputSchema>;
export type InvitationReplyJournalResult = z.infer<typeof invitationReplyJournalResultSchema>;
export type InvitationReplyJournalCommand = z.infer<typeof invitationReplyJournalCommandSchema>;
export type InvitationReplyEvent = z.infer<typeof invitationReplyEventSchema>;
export type InvitationReplyPreview = z.infer<typeof invitationReplyPreviewSchema>;
export type InvitationReplyResult = z.infer<typeof invitationReplyResultSchema>;
