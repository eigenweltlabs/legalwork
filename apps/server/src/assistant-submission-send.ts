import type { AssistantEngineClient } from "./assistant-engine.js";
import { runIdentifiedCommand } from "./native-command-control.js";
import { z } from "zod";
import type { AssistantSubmission } from "@legalwork/types/launcher";
import type { SubmissionPayload } from "./assistant-submissions.js";
import type { SessionMessageQueue } from "./session-message-queue.js";
import { ApiError } from "./errors.js";
import { dispatchQueueAction } from "./session-dispatch.js";
import type { QueueExecution } from "@legalwork/types/session-queue";

function commandArguments(payload: SubmissionPayload) {
  const context = payload.parts.flatMap(part => part.type === "text" && part.synthetic ? [part.text] : []).join("\n\n");
  return [payload.command?.arguments, context].filter(Boolean).join("\n\n");
}

function submissionExecution(messageId: string, payload: SubmissionPayload): Exclude<QueueExecution, { kind: "shell" }> {
  const visibleText = payload.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n");
  const reminders = payload.parts.flatMap(part => part.type === "text" && part.synthetic ? [part.text] : []);
  const metadata = Object.assign({}, ...payload.parts.flatMap(part => part.type === "text" && part.metadata ? [z.record(z.string(), z.json()).parse(part.metadata)] : []));
  const preferences = {
    ...(payload.agent ? { agent: payload.agent } : payload.command ? {} : { agent: "legalwork" }),
    ...(payload.model ? { model: { providerID: payload.model.providerID, id: payload.model.modelID, ...(payload.variant ? { variant: payload.variant } : {}) } } : {}),
    files: payload.parts.flatMap(part => part.type === "file" ? [{ uri: part.url, name: part.filename }] : []),
    agents: payload.parts.flatMap(part => part.type === "agent" ? [{ name: part.name }] : []),
    skills: payload.parts.flatMap(part => part.type === "skill" ? [{ id: part.id }] : []),
  };
  return payload.command ? { kind: "command", command: payload.command.name, args: commandArguments(payload), ...preferences }
    : { kind: "prompt", id: messageId, text: [visibleText, ...reminders].filter(Boolean).join("\n\n"), metadata: { ...metadata, legalworkPrompt: { visibleText, reminders } }, ...preferences };
}

/** Freeze a complete editable draft before dispatch, including popup producers
 * that do not supply Home's rich composer snapshot. Retries reuse this claim. */
export function stageAssistantSubmission(messageId: string, payload: SubmissionPayload): SubmissionPayload {
  if (payload.queue) return payload;
  const execution = submissionExecution(messageId, payload);
  const { id, draft } = dispatchQueueAction({ ...execution, id: messageId });
  if (payload.command) {
    const reminders = payload.parts.flatMap(part => part.type === "text" && part.synthetic ? [part.text] : []);
    const text = payload.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n");
    draft.text = text;
    draft.resolvedText = text;
    draft.command = payload.command;
    draft.parts = [{ type: "text", text }, ...draft.parts.filter(part => part.type !== "text")];
    if (reminders.length) draft.modelContext = reminders.join("\n\n");
  }
  return { ...payload, queue: { id, draft } };
}

/** Both Home and the popup wait for idle before selecting the saved model and
 * agent. The staging queue preserves the common engine message identity. */
export async function enqueueAssistantSubmission(queue: Pick<SessionMessageQueue, "act">, entry: AssistantSubmission, payload: SubmissionPayload) {
  if (!payload.queue) throw new ApiError(400, "submission_queue", "This message has no saved queue draft.");
  // This is an explicit user send. An existing entry is idempotent and cannot
  // resume a queue stopped after its first enqueue.
  return queue.act(entry.workspaceId, entry.sessionId, { type: "enqueue", ...payload.queue, messageId: entry.messageId,
    resumeStopped: true, execution: submissionExecution(entry.messageId, payload),
  });
}

/** Preserve the engine's command semantics and the common operation identity. */
export async function sendAssistantSubmission(client: AssistantEngineClient, entry: AssistantSubmission, payload: SubmissionPayload) {
  if (payload.command) {
    if (payload.agent) await client.native.session.switchAgent({ sessionID: entry.sessionId, agent: payload.agent });
    if (payload.model) await client.native.session.switchModel({ sessionID: entry.sessionId, model: { providerID: payload.model.providerID, id: payload.model.modelID, ...(payload.variant ? { variant: payload.variant } : {}) } });
    await runIdentifiedCommand(client.native, { sessionID: entry.sessionId, name: payload.command.name, text: commandArguments(payload),
      files: payload.parts.flatMap(part => part.type === "file" ? [{ uri: part.url, name: part.filename }] : []),
      agents: payload.parts.flatMap(part => part.type === "agent" ? [{ name: part.name }] : []),
      skills: payload.parts.flatMap(part => part.type === "skill" ? [{ id: part.id }] : []), delivery: "queue",
    }, entry.messageId);
    return;
  }
  const result = await client.session.promptAsync({ sessionID: entry.sessionId, messageID: entry.messageId, agent: payload.agent ?? "legalwork",
    ...(payload.model ? { model: payload.model } : {}), ...(payload.variant ? { variant: payload.variant } : {}), parts: payload.parts }, { signal: AbortSignal.timeout(30000) });
  if (!result.response.ok) throw new Error("Message delivery could not be confirmed.");
}
