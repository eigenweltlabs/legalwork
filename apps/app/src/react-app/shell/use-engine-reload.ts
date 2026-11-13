// Engine reload wiring for the session route: UI-triggered engine reload,
// reload-coordinator registration, the post-org-onboarding reload latch,
// server reload-event polling, and desktop engine info. Extracted verbatim
// from session-route.tsx; reload events are now typed (LegalworkReloadEvent)
// instead of `any`.
import { useCallback, useEffect, useRef, useState } from "react";

import { startRequestPolling } from "@/app/lib/request-poller";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";
import { engineInfo } from "@/app/lib/desktop";
import type { EngineInfo } from "@/app/lib/desktop-types";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { t } from "@/i18n";
import { useReloadCoordinator } from "./reload-coordinator";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import type { RouteWorkspace } from "./route-workspaces";

export type UseEngineReloadInput = {
  client: LegalworkServerClient | null;
  workspaceId: string;
  workspace: RouteWorkspace | null | undefined;
  endpointForWorkspace: (
    workspace: RouteWorkspace | null | undefined,
  ) => ResolvedWorkspaceEndpoint | null;
  activeReloadBlockingSessions: { id: string; title: string }[];
  onError: (message: string) => void;
  refreshRouteState: () => Promise<void>;
};

export function useEngineReload(input: UseEngineReloadInput) {
  const {
    client,
    workspaceId,
    workspace,
    endpointForWorkspace,
    activeReloadBlockingSessions,
    onError,
    refreshRouteState,
  } = input;
  const reloadCoordinator = useReloadCoordinator();
  const [engineReloadVersion, setEngineReloadVersion] = useState(0);
  const [routeEngineInfo, setRouteEngineInfo] = useState<EngineInfo | null>(null);
  const activePoller = useRef<ReturnType<typeof startRequestPolling> | null>(null);
  const sync = useSyncEventsLive();
  const previousSync = useRef(sync);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const reloadEventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});
  const resolvedEndpoint = client && workspaceId ? endpointForWorkspace(workspace) : null;
  const endpointKey = JSON.stringify([resolvedEndpoint?.baseUrl, resolvedEndpoint?.workspaceId, resolvedEndpoint?.token, resolvedEndpoint?.hostToken]);

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    if (!client || !workspaceId) {
      onError(t("app.error_connect_first"));
      return false;
    }
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint) {
      onError(t("app.error_connect_first"));
      return false;
    }
    await endpoint.client.reloadEngine(endpoint.workspaceId);
    await refreshProviderListQueries(getReactQueryClient());
    setEngineReloadVersion((v) => v + 1);
    try {
      window.dispatchEvent(new CustomEvent("legalwork-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }
    await refreshRouteState();
    return true;
  }, [client, endpointForWorkspace, onError, refreshRouteState, workspace, workspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(client && workspaceId),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
    });
  }, [activeReloadBlockingSessions, client, reloadCoordinator, reloadWorkspaceEngineFromUi, workspaceId]);

  useEffect(() => {
    const endpoint = resolvedEndpoint;
    if (!endpoint) return;
    const poller = startRequestPolling(async (signal) => {
      const currentCursor = reloadEventCursorByWorkspaceRef.current[endpointKey];
      const response = await endpoint.client.listReloadEvents(endpoint.workspaceId, {
        ...(typeof currentCursor === "number" ? { since: currentCursor } : {}), signal,
      });
      if (signal.aborted) return;
      reloadEventCursorByWorkspaceRef.current[endpointKey] = response.cursor ?? Math.max(currentCursor ?? 0, ...response.items.map(item => item.seq));
      // Establish a baseline before showing new changes, including after route entry.
      if (currentCursor === undefined || currentCursor === null) return;
      for (const event of response.items) reloadCoordinator.markReloadRequired(event.reason, event.trigger);
    }, { intervalMs: () => syncRef.current.live && syncRef.current.metadata && syncRef.current.baseUrl === endpoint.client.baseUrl ? 30_000 : 3000 });
    activePoller.current = poller;
    const unsubscribe = onSyncPoke(poke => {
      if (syncRef.current.baseUrl === endpoint.client.baseUrl && (poke.reload || poke.resync)) poller.wake();
    });
    return () => { unsubscribe(); poller.stop(); if (activePoller.current === poller) activePoller.current = null; };
  }, [endpointKey, reloadCoordinator]);

  useEffect(() => {
    const previous = previousSync.current;
    if (previous.live !== sync.live || previous.metadata !== sync.metadata || previous.baseUrl !== sync.baseUrl) activePoller.current?.wake();
    previousSync.current = sync;
  }, [sync.live, sync.metadata, sync.baseUrl]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void engineInfo()
      .then((info) => {
        // Pre-existing cast: the desktop bridge is a dynamic Proxy, so
        // engineInfo() returns unknown until the IPC surface is typed
        // (queued: DesktopCommandMap).
        if (!cancelled) setRouteEngineInfo(info as EngineInfo | null);
      })
      .catch(() => {
        if (!cancelled) setRouteEngineInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { engineReloadVersion, routeEngineInfo, reloadWorkspaceEngineFromUi };
}
