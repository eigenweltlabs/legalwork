/** @jsxImportSource react */
import { useSessionInboxStore } from "../sidebar/session-inbox-store";
import { useEffect } from "react";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { LegalworkSessionSnapshot } from "@/app/lib/legalwork-server";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { ensureWorkspaceSessionSync, snapshotKey, trackWorkspaceSessionsSync } from "./session-sync";

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
  assistantActive?: boolean;
  activeSessionIds?: string[];
  opencodeBaseUrl: string;
  legalworkToken: string;
  onSessionLoaded?: (session: Session) => void;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
};

export function ReactSessionRuntime(props: ReactSessionRuntimeProps) {
  useEffect(() => {
    const input = {
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      legalworkToken: props.legalworkToken,
      onSessionUpdated: props.onSessionUpdated,
      onSessionStatus: props.onSessionStatus,
    };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSessions = trackWorkspaceSessionsSync(input, [props.sessionId, ...(props.activeSessionIds ?? [])]);
    return () => {
      releaseSessions();
      releaseWorkspace();
    };
  }, [props.workspaceId, props.sessionId, props.activeSessionIds, props.opencodeBaseUrl, props.legalworkToken, props.onSessionUpdated, props.onSessionStatus]);

  // Only a loaded chat in the foreground is read. Sidebar expansion/prefetch is not reading.
  useEffect(() => {
    const sessionId = props.sessionId;
    if (!sessionId) return;
    const cache = getReactQueryClient();
    const key = snapshotKey(props.workspaceId, sessionId);
    const update = () => {
      const loaded = cache.getQueryData<LegalworkSessionSnapshot>(key)?.session.id === sessionId;
      useSessionInboxStore.getState().open(loaded && document.visibilityState === "visible" && document.hasFocus() ? sessionId : null,
        props.assistantActive ? props.workspaceId : null);
    };
    const unsubscribe = cache.getQueryCache().subscribe(event => { if (event.type === "updated" && key.every((part, index) => event.query.queryKey[index] === part)) update(); });
    window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
    update();
    return () => { unsubscribe(); window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); useSessionInboxStore.getState().open(null); };
  }, [props.workspaceId, props.sessionId, props.assistantActive]);

  // The open chat's snapshot is authoritative even when the sidebar's
  // paginated session list is stale or does not contain this conversation.
  useEffect(() => {
    if (!props.sessionId || !props.onSessionLoaded) return;
    const client = getReactQueryClient();
    const key = snapshotKey(props.workspaceId, props.sessionId);
    let previous: Session | undefined;
    const publish = () => {
      const session = client.getQueryData<LegalworkSessionSnapshot>(key)?.session;
      if (!session || session === previous) return;
      previous = session;
      props.onSessionLoaded?.(session);
    };
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && key.every((part, index) => event.query.queryKey[index] === part)) publish();
    });
    publish();
    return unsubscribe;
  }, [props.workspaceId, props.sessionId, props.onSessionLoaded]);

  return null;
}
