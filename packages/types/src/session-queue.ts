import { z } from "zod";

const model = z.object({ providerID: z.string(), modelID: z.string() });
const paste = z.object({ id: z.string(), label: z.string(), text: z.string(), lines: z.number() });
export const queuedDraftSchema = z.object({
  mode: z.enum(["prompt", "shell"]), text: z.string(), resolvedText: z.string().optional(), modelContext: z.string().optional(),
  command: z.object({ name: z.string(), arguments: z.string() }).optional(),
  parts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("paste"), ...paste.shape }),
    z.object({ type: z.literal("agent"), name: z.string() }),
    z.object({ type: z.literal("skill"), name: z.string() }),
    z.object({ type: z.literal("app"), name: z.string() }),
    z.object({ type: z.literal("file"), path: z.string(), label: z.string().optional() }),
  ])),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.number(), kind: z.enum(["image", "file"]), data: z.string().regex(/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/).refine(data => (data.length - data.indexOf(",") - 1) % 4 === 0) })),
  editor: z.object({
    mentions: z.record(z.string(), z.enum(["agent", "file", "memory", "upload", "storage", "app", "task", "review", "calendar"])),
    pasteParts: z.array(paste),
  }),
});
const prompt = z.object({
  kind: z.literal("prompt"), model, agent: z.string().optional(), variant: z.string().optional(), system: z.string().optional(),
  parts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string(), synthetic: z.boolean().optional() }),
    z.object({ type: z.literal("file"), url: z.string(), mime: z.string(), filename: z.string().optional() }),
    z.object({ type: z.literal("agent"), name: z.string() }),
  ])),
});
/** Older persisted queues carried per-turn context in `system`. Keep it on the
 * message when dispatching too, so resuming a queue cannot invalidate caching. */
export function queuedPromptPayload(execution: z.infer<typeof prompt>) {
  const { kind, system, ...payload } = execution;
  const parts = [...payload.parts];
  if (system?.trim()) parts.push({ type: "text", text: `<system-reminder>\n${system}\n</system-reminder>`, synthetic: true });
  return { ...payload, parts };
}
export const queueExecutionSchema = z.discriminatedUnion("kind", [
  prompt,
  z.object({ kind: z.literal("command"), command: z.string(), arguments: z.string(), model: z.string(), agent: z.string().optional(), variant: z.string().optional() }),
  z.object({ kind: z.literal("shell"), command: z.string() }),
]);
export const queueInputSchema = z.object({ id: z.string().uuid(), draft: queuedDraftSchema, execution: queueExecutionSchema, editToken: z.string().uuid().optional() });
export const queueEditSchema = z.object({ token: z.string().uuid(), expires: z.number() });
export const queueEntrySchema = queueInputSchema.omit({ editToken: true }).extend({ status: z.enum(["queued", "sending", "failed", "uncertain"]), edit: queueEditSchema.optional(), lastEditToken: z.string().optional(), error: z.string().optional() });
export const sessionQueueSchema = z.object({ workspaceId: z.string(), sessionId: z.string(), revision: z.number(), paused: z.boolean(), completedIds: z.array(z.string()).default([]), entries: z.array(queueEntrySchema) });
export const queueActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enqueue"), ...queueInputSchema.shape }),
  z.object({ type: z.literal("pause"), paused: z.boolean() }),
  z.object({ type: z.literal("remove"), id: z.string(), revision: z.number() }),
  z.object({ type: z.literal("reorder"), ids: z.array(z.string()), revision: z.number() }),
  z.object({ type: z.literal("edit"), id: z.string(), token: z.string().uuid(), revision: z.number() }),
  z.object({ type: z.literal("release"), id: z.string(), token: z.string().uuid() }),
  z.object({ type: z.literal("renew"), id: z.string(), token: z.string().uuid() }),
]);
export type QueuedDraftSnapshot = z.infer<typeof queuedDraftSchema>;
export type QueueExecution = z.infer<typeof queueExecutionSchema>;
export type QueueInput = z.infer<typeof queueInputSchema>;
export type QueueEntry = z.infer<typeof queueEntrySchema>;
export type SessionQueue = z.infer<typeof sessionQueueSchema>;
export type QueueAction = z.infer<typeof queueActionSchema>;
