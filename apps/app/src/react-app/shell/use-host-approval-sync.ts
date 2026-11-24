import { useEffect, useRef } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { refreshHostApprovals, type ApprovalWorkspace } from "./host-approval-feed";
import { onSyncPoke } from "@/react-app/kernel/sync-events";

/** Feed host decisions into the same per-chat queue as engine permissions. */
export function useHostApprovalSync(client: LegalworkServerClient | null, workspaces: readonly ApprovalWorkspace[], sessionId: string | null) {
  const workspaceKey = JSON.stringify(workspaces.map(workspace => [workspace.id, workspace.workspaceType]));
  const latest = useRef({ client, workspaces, workspaceKey });
  latest.current = { client, workspaces, workspaceKey };
  useEffect(() => {
    if (!client || !latest.current.workspaces.length) return;
    let stopped = false, running = false, pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (running) { pending = true; return; }
      running = true;
      try {
        const source = latest.current;
        await refreshHostApprovals(source.client, source.workspaces, () => !stopped && latest.current.client === source.client && latest.current.workspaceKey === source.workspaceKey);
      } catch { /* Retain pending decisions while the host reconnects. */ }
      finally {
        running = false;
        if (!stopped) {
          const again = pending;
          pending = false;
          // Reconcile even while SSE is live: an expiry must not leave a stale
          // decision on screen if its event raced a discarded snapshot.
          timer = setTimeout(() => void refresh(), again ? 0 : 5000);
        }
      }
    };
    const unsubscribe = onSyncPoke((poke) => { if (poke.approvals || poke.resync) void refresh(); });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    void refresh();
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); window.removeEventListener("focus", focus); };
  }, [client, workspaceKey, sessionId]);
}
