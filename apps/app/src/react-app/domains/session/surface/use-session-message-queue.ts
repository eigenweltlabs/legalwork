import { reconcileQueuedOrder } from "./queued-order";
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueueAction, QueueInput, QueuedDraftSnapshot, SessionQueue } from "@legalwork/types/session-queue";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import type { ComposerDraft } from "@/app/types";
import { useComposerStateStore, type QueuedComposerDraft, type ComposerSessionState } from "./composer-state-store";

const fileData = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Attachment could not be read."));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
export async function snapshotQueuedDraft(draft: ComposerDraft, editor?: ComposerSessionState): Promise<QueuedDraftSnapshot> {
  return { ...draft, attachments: await Promise.all(draft.attachments.map(async attachment => ({
    id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, kind: attachment.kind, data: await fileData(attachment.file),
  }))), editor: { mentions: editor?.mentions ?? {}, pasteParts: editor?.pasteParts ?? [] } };
}
function hydrateDraft(entry: SessionQueue["entries"][number], editToken?: string): QueuedComposerDraft {
  const attachments = entry.draft.attachments.map(attachment => {
    const encoded = attachment.data.slice(attachment.data.indexOf(",") + 1);
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return { ...attachment, file: new File([bytes], attachment.name, { type: attachment.mimeType }), previewUrl: attachment.kind === "image" ? attachment.data : undefined };
  });
  return { ...entry.draft, id: entry.id, attachments,
    status: entry.status, error: entry.error, locked: Boolean(entry.edit && entry.edit.token !== editToken),
    editor: { ...entry.draft.editor, draft: entry.draft.text, attachments } };
}

/** Queue state is shared; only the edit buffer and its stashed composer belong
 * to this window. A lease pauses delivery while a queued item is being edited. */
export function useSessionMessageQueue(client: LegalworkServerClient, workspaceId: string, sessionId: string) {
  const queryClient = useQueryClient();
  const key = ["session-message-queue", client.baseUrl, workspaceId, sessionId];
  const claim = useRef<{ id: string; token: string } | null>(null);
  const submission = useRef<{ signature: string; id: string } | null>(null);
  const query = useQuery({ queryKey: key, queryFn: async () => {
    const queue = await client.sessionMessageQueue(workspaceId, sessionId, queryClient.getQueryData<SessionQueue>(key));
    const previous = queryClient.getQueryData<SessionQueue>(key);
    return previous && previous.revision > queue.revision ? previous : queue;
  }, refetchInterval: query => query.state.data?.entries.length ? 1000 : 5000 });
  const latest = useRef(query.data); latest.current = query.data;
  const apply = useCallback((queue: SessionQueue) => {
    if (!latest.current || queue.revision >= latest.current.revision) latest.current = queue;
    queryClient.setQueryData<SessionQueue>(["session-message-queue", client.baseUrl, workspaceId, sessionId], previous => !previous || queue.revision >= previous.revision ? queue : previous);
  }, [client.baseUrl, workspaceId, sessionId, queryClient]);
  const update = useCallback(async (action: QueueAction) => {
    try { const state = await client.updateSessionMessageQueue(workspaceId, sessionId, action); apply(state); return state; }
    catch (error) { void queryClient.invalidateQueries({ queryKey: ["session-message-queue", client.baseUrl, workspaceId, sessionId] }); throw error; }
  }, [client, workspaceId, sessionId, queryClient, apply]);
  const connection = useRef({ client, update });
  connection.current = { client, update };
  useEffect(() => {
    if (!query.data) return;
    const items = query.data.entries.filter(entry => entry.status !== "sending").map(entry => hydrateDraft(entry, claim.current?.token));
    useComposerStateStore.setState(state => ({ queuedDrafts: { ...state.queuedDrafts, [sessionId]: items }, pausedQueues: { ...state.pausedQueues, [sessionId]: query.data.paused } }));
  }, [query.data, sessionId]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = claim.current;
      if (current) void connection.current.update({ type: "renew", ...current }).catch(() => {});
    }, 30_000);
    return () => {
      clearInterval(timer);
      const current = claim.current;
      const releaseClient = connection.current.client.baseUrl === client.baseUrl ? connection.current.client : client;
      if (current) void releaseClient.updateSessionMessageQueue(workspaceId, sessionId, { type: "release", ...current }).catch(() => {});
      claim.current = null;
    };
  }, [client.baseUrl, workspaceId, sessionId]);
  return {
    ready: query.isSuccess, error: query.error,
    enqueue: async (draft: ComposerDraft, send: (input: Omit<QueueInput, "execution">) => Promise<void>, preparedEditor?: ComposerSessionState) => {
      const editor = preparedEditor ?? useComposerStateStore.getState().sessions[sessionId];
      const snapshot = await snapshotQueuedDraft(draft, editor);
      const signature = JSON.stringify(snapshot);
      const current = editor?.queuedDraftId ? claim.current : null;
      if (editor?.queuedDraftId && current?.id !== editor.queuedDraftId) throw new Error("This queued edit is no longer owned by this window. Cancel editing to keep your original composer.");
      if (!submission.current || submission.current.signature !== signature) submission.current = { signature, id: crypto.randomUUID() };
      await send({ id: current?.id ?? submission.current.id, draft: snapshot, ...(current ? { editToken: current.token } : {}) });
      submission.current = null; claim.current = null;
      await query.refetch();
    },
    edit: async (id: string) => {
      if (claim.current) return;
      const token = crypto.randomUUID();
      const state = await update({ type: "edit", id, token, revision: latest.current?.revision ?? 0 });
      claim.current = { id, token };
      const entry = state.entries.find(item => item.id === id);
      if (!entry) return;
      useComposerStateStore.setState(current => ({ queuedDrafts: { ...current.queuedDrafts, [sessionId]: state.entries.filter(item => item.status !== "sending").map(item => hydrateDraft(item, token)) } }));
      useComposerStateStore.getState().editQueuedDraft(sessionId, id);
    },
    cancelEdit: async () => {
      const current = claim.current;
      try { if (current) await update({ type: "release", ...current }); }
      catch (error) { if (!(error instanceof LegalworkServerError && error.status === 409)) throw error; }
      claim.current = null;
    },
    remove: (id: string) => update({ type: "remove", id, revision: latest.current?.revision ?? 0 }),
    reorder: async (ids: string[]) => {
      const action = (state: SessionQueue | undefined): QueueAction => ({ type: "reorder",
        ids: reconcileQueuedOrder(ids, state?.entries.filter(entry => entry.status !== "sending").map(entry => entry.id) ?? ids),
        revision: state?.revision ?? 0 });
      try { return await update(action(latest.current)); }
      catch (error) {
        if (!(error instanceof LegalworkServerError && error.status === 409)) throw error;
        // A draft can begin delivery or arrive from another window during a drag.
        const current = await client.sessionMessageQueue(workspaceId, sessionId);
        apply(current);
        return update(action(current));
      }
    },
    pause: (paused: boolean, reason?: "stop") => update({ type: "pause", paused, reason }),
  };
}
