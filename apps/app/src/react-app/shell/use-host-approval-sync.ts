import { useEffect, useRef } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { workspaceServerId } from "@/app/lib/workspace-endpoint";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";
import { seedHostApprovalState } from "../domains/session/sync/session-sync";
import type { RouteWorkspace } from "./route-workspaces";

/** Feed host decisions into the same per-chat queue as engine permissions. */
export function useHostApprovalSync(client: LegalworkServerClient | null, workspaces: RouteWorkspace[], sessionId: string | null) {
  const latest = useRef({ client, workspaces });
  latest.current = { client, workspaces };
  const workspaceKey = workspaces.map((workspace) => workspace.id).join("|");
  useEffect(() => {
    if (!client?.canApprove) return;
    let stopped = false, running = false, pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (heard = false) => {
      clearTimeout(timer);
      if (running) { pending = true; return; }
      running = true;
      try {
        if (!heard && useSyncEventsLive.getState().live) return;
        const result = await latest.current.client?.pendingHostApprovals();
        if (stopped || !result) return;
        for (const workspace of latest.current.workspaces) {
          if (workspace.workspaceType === "remote") continue;
          seedHostApprovalState(workspace.id, result.items.filter((request) => request.workspaceId === workspaceServerId(workspace)));
        }
      } catch { /* Retain pending decisions while the host reconnects. */ }
      finally {
        running = false;
        if (!stopped) {
          const again = pending;
          pending = false;
          timer = setTimeout(() => void refresh(again), again ? 0 : 5000);
        }
      }
    };
    const unsubscribe = onSyncPoke((poke) => { if (poke.approvals || poke.resync) void refresh(true); });
    const focus = () => { void refresh(true); };
    window.addEventListener("focus", focus);
    void refresh(true);
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); window.removeEventListener("focus", focus); };
  }, [client?.baseUrl, client?.canApprove, workspaceKey, sessionId]);
}
