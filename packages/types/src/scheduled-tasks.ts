import { z } from "zod";

const common = { startAt: z.union([z.iso.datetime({ offset: true }), z.iso.datetime({ local: true })]), timeZone: z.string().min(1).max(100) };
export const TaskScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), ...common }),
  z.strictObject({ kind: z.literal("interval"), ...common, minutes: z.number().int().min(1).max(525600) }),
  z.strictObject({ kind: z.literal("rrule"), ...common, rrule: z.string().trim().min(1).max(500) }),
]);
export const ScheduledTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(30000),
  schedule: TaskScheduleSchema,
  projectAccess: z.enum(["project", "all"]).default("project"),
  sessionId: z.string().min(1).max(200).nullable(),
  // Older clients used a null sessionId to request a new chat on every run.
  reuseChat: z.boolean().default(false),
  pinSession: z.boolean().default(true),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).nullable().default(null),
});
export const ScheduledTaskSchema = ScheduledTaskInputSchema.extend({
  id: z.uuid(), workspaceId: z.string(), revision: z.number().int(),
  status: z.enum(["active", "paused", "completed"]), nextRunAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export const ScheduledRunSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), dueAt: z.string(), startedAt: z.string(),
  projectAccess: z.enum(["project", "all"]).default("project"),
  pinSession: z.boolean().default(true),
  sessionId: z.string().nullable(), status: z.enum(["dispatching", "sent", "failed"]), error: z.string().nullable(),
});
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;
export type ScheduledTaskInput = z.infer<typeof ScheduledTaskInputSchema>;
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;
export type ScheduledRun = z.infer<typeof ScheduledRunSchema>;

/** Sidebar metadata only. Transcript contents never leave the engine through this endpoint. */
export type SessionInboxEntry = {
  workspaceId: string; sessionId: string; updatedAt: number; assistantAt: number;
  status?: "idle" | "busy" | "retry" | "unknown";
  automation?: { runId: string; at: number; pinRunId: string | null };
};
