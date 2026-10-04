import { z } from "zod";

export const CalendarDaySchema = z.iso.date();
export const CalendarValueSchema = z.union([CalendarDaySchema, z.iso.datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)]);
export const DeadlineCalculationSchema = z.object({
  id: z.uuid(), skill: z.string(), version: z.string(), rule: z.string(),
  input: z.record(z.string(), z.unknown()), inputHash: z.string(),
  deadlineDay: CalendarDaySchema, cutoff: z.string(), timeZone: z.string(),
  trace: z.array(z.string()), sources: z.array(z.string()), codeHash: z.string(),
  createdAt: z.iso.datetime(),
});
export type DeadlineCalculation = z.infer<typeof DeadlineCalculationSchema>;

export const CalendarProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), source: z.string().max(4000).default(""), reason: z.string().max(4000).default("") }),
  z.object({ kind: z.literal("imported"), source: z.string().max(4000).default("") }),
  z.object({ kind: z.literal("calculated"), calculation: DeadlineCalculationSchema }),
]);
// Portable project-relative files only; attachments use the existing project file sync.
export const CalendarAttachmentPathSchema = z.string().min(1).max(2000).refine(path =>
  !/[\\:\x00-\x1f\x7f]/.test(path) && path.split("/").every(part => part.length > 0 && !part.startsWith(".")),
  "Use a visible project-relative file path.");
const attachmentPaths = z.array(CalendarAttachmentPathSchema).max(50);
const sessionIds = z.array(z.string().min(1).max(255)).max(50);

export const CalendarItemSchema = z.object({
  id: z.uuid(), uid: z.string().min(1).max(255), projectId: z.string().min(1),
  kind: z.enum(["event", "deadline", "journal", "freebusy"]),
  title: z.string().max(1000), description: z.string().max(20000),
  start: CalendarValueSchema.nullable(), end: CalendarValueSchema.nullable(), timeZone: z.string(),
  status: z.enum(["active", "completed", "cancelled"]), verified: z.boolean(),
  assigneeUserId: z.string().nullable(), taskIds: z.array(z.string()).max(100),
  attachmentPaths: attachmentPaths.default([]), sessionIds: sessionIds.default([]),
  reminders: z.array(z.number().int().min(0).max(525600)).max(20),
  provenance: CalendarProvenanceSchema, ical: z.string().max(2_000_000),
  revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type CalendarItem = z.infer<typeof CalendarItemSchema>;
export type CalendarOccurrence = {
  id: string; itemId: string; uid: string; projectId: string | null; projectName: string;
  kind: CalendarItem["kind"] | "task"; title: string; start: string; end: string | null;
  allDay: boolean; timeZone: string; status: string; assigneeUserId: string | null;
  provenance: CalendarItem["provenance"] | null; verified: boolean; recurring: boolean;
};

export const CalendarCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(1000), description: z.string().max(20000).default(""),
  kind: z.enum(["event", "deadline"]).default("deadline"),
  start: CalendarValueSchema, end: CalendarValueSchema.nullable().optional(),
  timeZone: z.string().min(1).max(100).default("Europe/Berlin"),
  source: z.string().max(4000).default(""), reason: z.string().max(4000).default(""),
  assigneeUserId: z.string().nullable().default(null), taskIds: z.array(z.string()).max(100).default([]),
  attachmentPaths: attachmentPaths.default([]), sessionIds: sessionIds.default([]),
  reminders: z.array(z.number().int().min(0).max(525600)).max(20).default([1440]),
});
export const CalendarPatchSchema = z.strictObject({
  calculationId: z.uuid().optional().describe("Receipt for a recalculated deadline. The final date and time zone must match it exactly."),
  title: CalendarCreateSchema.shape.title.optional(),
  description: CalendarCreateSchema.shape.description.unwrap().optional(),
  kind: CalendarCreateSchema.shape.kind.unwrap().optional(), start: CalendarValueSchema.optional(), end: CalendarValueSchema.nullable().optional(),
  timeZone: CalendarCreateSchema.shape.timeZone.unwrap().optional(),
  source: CalendarCreateSchema.shape.source.unwrap().optional(), reason: CalendarCreateSchema.shape.reason.unwrap().optional(),
  assigneeUserId: CalendarCreateSchema.shape.assigneeUserId.unwrap().optional(),
  taskIds: CalendarCreateSchema.shape.taskIds.unwrap().optional(), reminders: CalendarCreateSchema.shape.reminders.unwrap().optional(),
  attachmentPaths: attachmentPaths.optional(), sessionIds: sessionIds.optional(),
  revision: z.number().int().nonnegative(), status: z.enum(["active", "completed", "cancelled"]).optional(), verified: z.boolean().optional(),
});
export const CalendarSyncDocumentSchema = z.object({
  id: z.uuid(), uid: z.string(), revision: z.number().int().nonnegative(),
  data: CalendarItemSchema, baseRevision: z.number().int().nonnegative(),
});
