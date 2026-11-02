import { z } from "zod";

const model = z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() });
const legacyModel = z.object({ providerID: z.string(), modelID: z.string() });
const file = z.object({ uri: z.string(), name: z.string().optional(), description: z.string().optional(), mention: z.object({ start: z.number(), end: z.number(), text: z.string() }).optional() });
const agent = z.object({ name: z.string(), mention: z.object({ start: z.number(), end: z.number(), text: z.string() }).optional() });
const skill = z.object({ id: z.string(), mention: z.object({ start: z.number(), end: z.number(), text: z.string() }).optional() });
const metadata = z.record(z.string(), z.json());
const paste = z.object({ id: z.string(), label: z.string(), text: z.string(), lines: z.number() });
export const queuedDraftSchema = z.object({
  mode: z.enum(["prompt", "shell"]), text: z.string(), resolvedText: z.string().optional(), modelContext: z.string().optional(),
  command: z.object({ name: z.string(), arguments: z.string() }).optional(),
  parts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("paste"), ...paste.shape }),
    z.object({ type: z.literal("agent"), name: z.string() }),
    z.object({ type: z.literal("skill"), name: z.string() }),
    z.object({ type: z.literal("plugin"), pluginId: z.string(), label: z.string() }),
    z.object({ type: z.literal("app"), name: z.string() }),
    z.object({ type: z.literal("file"), path: z.string(), label: z.string().optional() }),
  ])),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.number(), kind: z.enum(["image", "file"]), data: z.string().regex(/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/).refine(data => (data.length - data.indexOf(",") - 1) % 4 === 0) })),
  editor: z.object({
    mentions: z.record(z.string(), z.enum(["agent", "file", "memory", "upload", "storage", "app", "task", "review", "calendar", "plugin", "integration"])),
    pasteParts: z.array(paste),
  }),
});
const prompt = z.object({
  kind: z.literal("prompt"), id: z.string().optional(), text: z.string(), files: z.array(file).optional(), agents: z.array(agent).optional(), skills: z.array(skill).optional(),
  metadata: metadata.optional(), model: model.optional(), agent: z.string().optional(),
});
const command = z.object({
  kind: z.literal("command"), command: z.string(), args: z.string(), files: z.array(file).optional(), agents: z.array(agent).optional(), skills: z.array(skill).optional(),
  model: model.optional(), unresolvedModel: z.string().optional(), agent: z.string().optional(),
});
const shell = z.object({ kind: z.literal("shell"), command: z.string() });

/** Decode existing durable queue files once into native v2 intent. Keep every
 * text/file/agent and put old system context in the chronological user message. */
const legacyPrompt = z.object({
  kind: z.literal("prompt"), model: legacyModel, agent: z.string().optional(), variant: z.string().optional(), system: z.string().optional(),
  parts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string(), synthetic: z.boolean().optional() }),
    z.object({ type: z.literal("file"), url: z.string(), mime: z.string(), filename: z.string().optional() }),
    z.object({ type: z.literal("agent"), name: z.string() }),
  ])),
}).transform((value): z.infer<typeof prompt> => {
  const visibleText = value.parts.flatMap(part => part.type === "text" && !part.synthetic ? [part.text] : []).join("\n");
  const reminders = value.parts.flatMap(part => part.type === "text" && part.synthetic ? [part.text] : []);
  if (value.system?.trim()) reminders.push(`<system-reminder>\n${value.system}\n</system-reminder>`);
  return {
    kind: value.kind, text: [visibleText, ...reminders].filter(Boolean).join("\n\n"),
    files: value.parts.flatMap(part => part.type === "file" ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }] : []),
    agents: value.parts.flatMap(part => part.type === "agent" ? [{ name: part.name }] : []),
    metadata: { legalworkPrompt: { visibleText, reminders } },
    model: { providerID: value.model.providerID, id: value.model.modelID, ...(value.variant ? { variant: value.variant } : {}) },
    ...(value.agent ? { agent: value.agent } : {}),
  };
});
const legacyCommand = z.object({
  kind: z.literal("command"), command: z.string(), arguments: z.string(), model: z.string(), agent: z.string().optional(), variant: z.string().optional(),
}).transform((value): z.infer<typeof command> => {
  const separator = value.model.indexOf("/");
  const reference = value.model.slice(separator + 1);
  const fragment = reference.indexOf("#");
  const variant = value.variant || (fragment >= 0 ? reference.slice(fragment + 1) : undefined);
  return { kind: value.kind, command: value.command, args: value.arguments,
    ...(separator > 0 ? { model: { providerID: value.model.slice(0, separator), id: fragment >= 0 ? reference.slice(0, fragment) : reference, ...(variant ? { variant } : {}) } } : {}),
    ...(separator <= 0 && value.model ? { unresolvedModel: `${value.model}${variant ? `#${variant}` : ""}` } : {}),
    ...(value.agent ? { agent: value.agent } : {}),
  };
});
export const sessionDispatchSchema = z.discriminatedUnion("kind", [
  prompt.extend({ delivery: z.enum(["queue", "steer"]).optional(), resume: z.boolean().optional(), waitForCompletion: z.boolean().optional(), draft: queuedDraftSchema.optional() }),
  command.extend({ id: z.string().optional(), delivery: z.enum(["queue", "steer"]).optional(), waitForCompletion: z.boolean().optional(), draft: queuedDraftSchema.optional() }),
  z.object({ kind: z.literal("synthetic"), id: z.string().optional(), text: z.string(), description: z.string().optional(), metadata: metadata.optional(),
    delivery: z.enum(["queue", "steer"]).optional(), resume: z.boolean().optional(), waitForCompletion: z.boolean().optional() }),
]);
export type SessionDispatch = z.infer<typeof sessionDispatchSchema>;
export type SessionDispatchReceipt = { accepted: true; messageID?: string; staged: boolean };
export const queueExecutionSchema = z.union([prompt, command, shell, legacyPrompt, legacyCommand]);
export function queuedPromptPayload(execution: z.infer<typeof prompt>) {
  const { kind, model, agent, ...payload } = execution;
  return payload;
}
export const queueInputSchema = z.object({ id: z.string().uuid(), draft: queuedDraftSchema, execution: queueExecutionSchema, editToken: z.string().uuid().optional() });
export const queueEditSchema = z.object({ token: z.string().uuid(), expires: z.number() });
export const queueEntrySchema = queueInputSchema.omit({ editToken: true }).extend({
  status: z.enum(["queued", "sending", "accepted", "failed", "uncertain"]), edit: queueEditSchema.optional(), lastEditToken: z.string().optional(), error: z.string().optional(), dispatchRevision: z.number().optional(),
  // Durable delivery intent, separate from the saved model/agent selection.
  delivery: z.literal("steer").optional(), contentRevision: z.number().optional(),
});
export const sessionQueueSchema = z.object({ workspaceId: z.string(), sessionId: z.string(), revision: z.number(), paused: z.boolean(), pauseReason: z.enum(["stop", "error"]).optional(), resumeRevision: z.number().optional(), completedIds: z.array(z.string()).default([]), entries: z.array(queueEntrySchema) });
export const queueActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enqueue"), ...queueInputSchema.shape, resumeStopped: z.boolean().optional() }),
  z.object({ type: z.literal("pause"), paused: z.boolean(), reason: z.literal("stop").optional() }),
  z.object({ type: z.literal("steer"), id: z.string(), revision: z.number() }),
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
