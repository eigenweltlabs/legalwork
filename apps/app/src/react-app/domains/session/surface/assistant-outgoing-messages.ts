import type { QueuedDraftSnapshot, SessionQueue } from "@legalwork/types/session-queue";
import type { UIMessage } from "ai";
import { create } from "zustand";
import type { ComposerDraft } from "@/app/types";
import { integrationReferencesFromDraft } from "./composer/integration-message";

type OutgoingMessage = { scope: string; queueId: string; message: UIMessage; urls: string[] };
export const assistantOutgoingScope = (baseUrl: string, workspaceId: string, sessionId: string) => JSON.stringify([baseUrl, workspaceId, sessionId]);

// Matches native-queue-transport's durable message ID, so confirmation replaces
// the local bubble without remounting it or comparing potentially identical text.
export const outgoingMessageId = (queueId: string) => `msg_${queueId.replaceAll("-", "")}`;
export const useAssistantOutgoingMessages = create<{ entries: OutgoingMessage[] }>(() => ({ entries: [] }));

export function addAssistantOutgoingMessage(scope: string, queueId: string, draft: ComposerDraft) {
  removeAssistantOutgoingMessage(queueId);
  const urls = draft.attachments.map(attachment => URL.createObjectURL(attachment.file));
  const message = outgoingMessage(queueId, draft, urls);
  useAssistantOutgoingMessages.setState(state => ({ entries: [...state.entries, { scope, queueId, message, urls }] }));
}

function outgoingMessage(queueId: string, draft: Pick<QueuedDraftSnapshot, "parts" | "text"> & { attachments: { name: string; mimeType: string }[] }, urls: string[]): UIMessage {
  const integrations = integrationReferencesFromDraft(draft.text);
  const text = draft.parts.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "paste") return `[pasted text ${part.label}]`;
    if (part.type === "file") return `@${part.label ?? part.path}`;
    if (part.type === "plugin") return `@${part.label}`;
    return `@${part.name}`;
  }).join("");
  return {
    id: outgoingMessageId(queueId), role: "user",
    metadata: { localOutgoing: true, opencode: { created: Date.now() } },
    parts: [
      ...draft.attachments.map((attachment, index) => ({ type: "file", filename: attachment.name, mediaType: attachment.mimeType, url: urls[index] } satisfies UIMessage["parts"][number])),
      ...(text ? [{ type: "text", text, ...(integrations.length ? { providerMetadata: { opencode: { integrations } } } : {}) } satisfies UIMessage["parts"][number]] : []),
    ],
  };
}

// Admission precedes history while a tool is running. Use the durable queue's
// visible draft, never its prepared execution text (which has hidden context).
function acceptedSteeringMessages(scope: string, queue?: SessionQueue): OutgoingMessage[] {
  return queue?.entries.flatMap(entry => {
    if (entry.delivery !== "steer" || entry.status !== "accepted" || entry.execution.kind !== "prompt") return [];
    const message = outgoingMessage(entry.id, entry.draft, entry.draft.attachments.map(file => file.data));
    if (entry.execution.id) message.id = entry.execution.id;
    return [{ scope, queueId: entry.id, message, urls: [] }];
  }) ?? [];
}

export function rememberAcceptedSteeringMessages(scope: string, queue: SessionQueue | undefined, confirmed: Set<string>) {
  useAssistantOutgoingMessages.setState(state => {
    const existing = new Set(state.entries.filter(entry => entry.scope === scope).map(entry => entry.message.id));
    const added = acceptedSteeringMessages(scope, queue).filter(entry => !existing.has(entry.message.id) && !confirmed.has(entry.message.id));
    return added.length ? { entries: [...state.entries, ...added] } : state;
  });
}

export function removeAssistantOutgoingMessage(queueId: string) {
  const entries = useAssistantOutgoingMessages.getState().entries;
  const entry = entries.find(item => item.queueId === queueId);
  if (!entry) return;
  entry.urls.forEach(url => URL.revokeObjectURL(url));
  useAssistantOutgoingMessages.setState({ entries: entries.filter(item => item !== entry) });
}

export function moveAssistantOutgoingMessage(queueId: string, scope: string) {
  useAssistantOutgoingMessages.setState(state => ({ entries: state.entries.map(entry => entry.queueId === queueId ? { ...entry, scope } : entry) }));
}

export function mergeAssistantOutgoingMessages(messages: UIMessage[], entries: OutgoingMessage[], scope: string, queue?: SessionQueue) {
  const ids = new Set(messages.map(message => message.id));
  const pending = [...entries, ...acceptedSteeringMessages(scope, queue)].filter(entry => {
    if (entry.scope !== scope || ids.has(entry.message.id) || assistantOutgoingIsQueued(entry.queueId, queue)) return false;
    ids.add(entry.message.id);
    return true;
  });
  return pending.length ? [...messages, ...pending.map(entry => entry.message)] : messages;
}

export function isLocalOutgoingMessage(message: UIMessage) {
  return Boolean(message.metadata && typeof message.metadata === "object" && "localOutgoing" in message.metadata && message.metadata.localOutgoing === true);
}

/** Any idle chat can preview an ordinary prompt with a durable message ID. */
export function canPreviewAssistantSend(queue: SessionQueue | undefined, busy: boolean, editing: boolean, outgoing: boolean, draft: Pick<ComposerDraft, "mode" | "command">) {
  return Boolean(queue && !queue.paused && queue.entries.length === 0 && !busy && !editing && !outgoing && draft.mode === "prompt" && !draft.command);
}

/** The server can discover work that the submitting window has not seen yet. */
export function assistantOutgoingIsQueued(queueId: string, queue?: SessionQueue) {
  return Boolean(queue?.entries.some(entry => entry.id === queueId && entry.status !== "sending" && entry.status !== "accepted"));
}
