import { createHash, randomUUID } from "node:crypto";
import type { QueueAction, QueuedDraftSnapshot, SessionDispatch } from "@legalwork/types/session-queue";

/** Stable staging identity for a retried native message ID. No user text or
 * private file content becomes a filename. Commands without an ID get a new
 * claim and are never automatically retried after uncertain delivery. */
function stagingID(id: string | undefined): string {
  if (!id) return randomUUID();
  const hex = createHash("sha256").update(id).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type QueuedDispatch = Exclude<SessionDispatch, { kind: "synthetic" }>;
function promptText(input: QueuedDispatch) {
  if (input.kind !== "prompt") return { text: input.args, reminders: [] };
  const context = input.metadata?.legalworkPrompt;
  if (context && typeof context === "object" && !Array.isArray(context) && typeof context.visibleText === "string") {
    return { text: context.visibleText, reminders: Array.isArray(context.reminders) ? context.reminders.filter((value): value is string => typeof value === "string") : [] };
  }
  return { text: input.text, reminders: [] };
}

/** Non-composer producers also retain their complete native intent. Rich
 * composer drafts can be supplied unchanged; this fallback restores plain
 * prompts, attachment chips and command arguments for editing after restart. */
function fallbackDraft(input: QueuedDispatch): QueuedDraftSnapshot {
  const { text, reminders } = promptText(input);
  const attachments: QueuedDraftSnapshot["attachments"] = [];
  const parts: QueuedDraftSnapshot["parts"] = [{ type: "text", text }];
  for (const [index, file] of (input.files ?? []).entries()) {
    const inline = /^data:([^,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.uri);
    if (inline) attachments.push({ id: `attachment-${index}`, name: file.name ?? `Attachment ${index + 1}`, mimeType: inline[1],
      size: Buffer.byteLength(inline[2], "base64"), kind: inline[1].startsWith("image/") ? "image" : "file", data: file.uri });
    else parts.push({ type: "file", path: file.uri, label: file.name });
  }
  for (const agent of input.agents ?? []) parts.push({ type: "agent", name: agent.name });
  for (const skill of input.skills ?? []) parts.push({ type: "skill", name: skill.id });
  return { mode: "prompt", text, resolvedText: text, ...(reminders.length ? { modelContext: reminders.join("\n\n") } : {}),
    ...(input.kind === "command" ? { command: { name: input.command, arguments: input.args } } : {}), parts, attachments, editor: { mentions: {}, pasteParts: [] } };
}

export function dispatchQueueAction(input: QueuedDispatch): Extract<QueueAction, { type: "enqueue" }> {
  const id = stagingID(input.id);
  const { delivery, waitForCompletion, draft, ...execution } = input;
  if (execution.kind === "prompt") {
    const { resume, ...prompt } = execution;
    return { type: "enqueue", id, draft: draft ?? fallbackDraft(input), execution: { ...prompt, id: prompt.id ?? `msg_${id.replaceAll("-", "")}` } };
  }
  return { type: "enqueue", id, draft: draft ?? fallbackDraft(input), execution };
}
