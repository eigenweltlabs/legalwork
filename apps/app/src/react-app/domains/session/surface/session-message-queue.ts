import type { Client, ComposerDraft } from "@/app/types";
import { unwrap } from "@/app/lib/opencode";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useSessionActivityStore } from "../status/session-activity-store";
import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "../sync/session-sync";
import { isComposerQueuePaused, useComposerStateStore } from "./composer-state-store";
import { createMessageQueueRunner } from "./message-queue-runner";

const queues = new Map<string, { wake: () => Promise<void> }>();

export function ensureSessionMessageQueue(input: {
  workspaceId: string;
  sessionId: string;
  baseUrl: string;
  legalworkToken: string;
  client: Client;
  send: (draft: ComposerDraft) => Promise<void>;
}) {
  const { workspaceId, sessionId } = input;
  const key = `${workspaceId}:${sessionId}`;
  const existing = queues.get(key);
  if (existing) { void existing.wake(); return; }
  const store = useComposerStateStore;
  const activity = useSessionActivityStore;
  const runner = createMessageQueueRunner({
    next: () => store.getState().queuedDrafts[sessionId]?.[0],
    paused: () => isComposerQueuePaused(store.getState(), sessionId),
    isIdle: async () => {
      const status = activity.getState().getStatus(workspaceId, sessionId);
      if (status === "error") { store.getState().setQueuePaused(sessionId, true); return false; }
      if (status !== "idle") return false;
      const statuses = unwrap(await input.client.session.status());
      return !statuses[sessionId] || statuses[sessionId].type === "idle";
    },
    take: (item) => {
      store.getState().removeQueuedDraft(sessionId, item.id);
      store.getState().appendHistory(sessionId, item.text);
      activity.getState().setRunStatus(workspaceId, sessionId, { type: "busy" });
    },
    send: async (item) => {
      await input.send(item);
      for (const attachment of item.attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    failed: (error, item) => {
      store.getState().setQueuePaused(sessionId, true);
      if (item) store.getState().prependQueuedDrafts(sessionId, [item]);
      const message = error instanceof Error ? error.message : String(error);
      activity.getState().setError(workspaceId, sessionId, message);
      toast.error(t("composer.queue_failed"), { description: message });
    },
    drained: () => {
      runner.dispose();
      clearInterval(poll);
      releaseActivity();
      releaseStore();
      releaseSession();
      releaseSync();
      queues.delete(key);
    },
  });
  queues.set(key, runner);
  // Keep SSE alive even when the user leaves this session or its project.
  const sync = { workspaceId, baseUrl: input.baseUrl, legalworkToken: input.legalworkToken };
  const releaseSync = ensureWorkspaceSessionSync(sync);
  const releaseSession = trackWorkspaceSessionSync(sync, sessionId);
  const releaseActivity = activity.subscribe(() => { void runner.wake(); });
  const releaseStore = store.subscribe(() => { void runner.wake(); });
  const poll = setInterval(() => { void runner.wake(); }, 3000);
  void runner.wake();
}
