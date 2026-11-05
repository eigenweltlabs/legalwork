import { z } from "zod";
import { ScheduledTaskMessageSchema } from "./scheduled-tasks.js";

/** Presentation provenance only. Never replay these references as native files. */
export const HistoricalAttachmentSchema = z.object({
  partID: z.string(), name: z.string().optional(), mime: z.string(),
  reference: z.string().optional(), sourcePath: z.string().optional(),
  bytes: z.enum(["preserved-inline", "reference-only"]),
  nativeFileIndex: z.number().int().nonnegative().optional(),
});
export const HistoricalMessageSchema = z.object({
  scheduledTask: ScheduledTaskMessageSchema.optional(),
  attachments: z.array(HistoricalAttachmentSchema),
});
export const HistoryUndoStatusSchema=z.object({status:z.enum(["restored","unresolved"]),reason:z.string().optional()});
export type HistoryUndoStatus=z.infer<typeof HistoryUndoStatusSchema>;
export const SessionHistoryProvenanceSchema = z.object({
  version: z.literal(1), status: z.enum(["available", "not-migrated", "unavailable"]),
  messages: z.record(z.string(), HistoricalMessageSchema),
  issue: z.string().optional(),
  undo:HistoryUndoStatusSchema.optional(),
});
export type HistoricalAttachment = z.infer<typeof HistoricalAttachmentSchema>;
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>;
export type SessionHistoryProvenance = z.infer<typeof SessionHistoryProvenanceSchema>;
