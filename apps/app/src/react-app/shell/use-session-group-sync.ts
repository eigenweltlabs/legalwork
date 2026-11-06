import { useEffect, useRef } from "react";

import { LegalworkServerError, type LegalworkSessionGroupState } from "@/app/lib/legalwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import {
  applySessionGroupServerState,
  beginSessionGroupServerSync,
  setSessionGroupSyncHandler,
  useSessionManagementStore,
  type SessionGroupDefinition,
  type SessionGroupServerState,
  type WorkspaceGroupState,
} from "@/react-app/domains/session/sidebar/session-management-store";
import { startRequestPolling } from "@/app/lib/request-poller";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";
import type { RouteWorkspace } from "./route-workspaces";

const MIGRATION_PREFIX = "legalwork.sessionGroups.migrated.v2";

type UseSessionGroupSyncInput = {
  workspaces: RouteWorkspace[];
  endpointForWorkspace: (workspace: RouteWorkspace | null | undefined) => ResolvedWorkspaceEndpoint | null;
};

function hasGroupData(state: SessionGroupServerState | WorkspaceGroupState | undefined): boolean {
  return Boolean(state && (state.groups.length > 0 || Object.keys(state.assignments).length > 0));
}

function serverStateFromWorkspaceState(state: WorkspaceGroupState): LegalworkSessionGroupState {
  return {
    groups: state.groups.map((group) => ({ id: group.id, label: group.label })),
    assignments: { ...state.assignments },
  };
}

function localGroupStateForWorkspace(
  workspace: RouteWorkspace,
  endpoint: ResolvedWorkspaceEndpoint,
): WorkspaceGroupState | undefined {
  const byWorkspace = useSessionManagementStore.getState().groupsByWorkspace;
  const ids = [workspace.id, endpoint.workspaceId, `rem_${endpoint.workspaceId}`];
  for (const id of ids) {
    const state = byWorkspace[id];
    if (hasGroupData(state)) return state;
  }
  return undefined;
}

function migrationKey(endpoint: ResolvedWorkspaceEndpoint): string {
  return `${MIGRATION_PREFIX}:${endpoint.baseUrl}:${endpoint.workspaceId}`;
}

function readMigrationComplete(endpoint: ResolvedWorkspaceEndpoint): boolean {
  try {
    return window.localStorage.getItem(migrationKey(endpoint)) === "1";
  } catch {
    return false;
  }
}

function writeMigrationComplete(endpoint: ResolvedWorkspaceEndpoint): void {
  try {
    window.localStorage.setItem(migrationKey(endpoint), "1");
  } catch {
    // ignore storage failures; the next launch can retry safely.
  }
}

export function useSessionGroupSync(input: UseSessionGroupSyncInput): void {
  const { workspaces, endpointForWorkspace } = input;
  const workspacesRef = useRef(workspaces);
  const endpointForWorkspaceRef = useRef(endpointForWorkspace);
  const eventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});
  const pollers = useRef<ReturnType<typeof startRequestPolling>[]>([]);
  const sync = useSyncEventsLive();
  const previousSync = useRef(sync);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const endpointKey = JSON.stringify(workspaces.map(workspace => {
    const endpoint = endpointForWorkspace(workspace);
    return [workspace.id, endpoint?.baseUrl, endpoint?.token, endpoint?.hostToken];
  }));

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    endpointForWorkspaceRef.current = endpointForWorkspace;
  }, [endpointForWorkspace]);

  useEffect(() => {
    setSessionGroupSyncHandler({
      createGroup: async (workspaceId: string, group: SessionGroupDefinition) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.createSessionGroup(endpoint.workspaceId, group);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      assignGroup: async (workspaceId: string, sessionId: string, groupId: string | null) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.assignSessionGroup(endpoint.workspaceId, sessionId, groupId);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      reorderGroups: async (workspaceId: string, groupIds: string[]) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.reorderSessionGroups(endpoint.workspaceId, groupIds);
        writeMigrationComplete(endpoint);
        return response.state;
      },
      removeGroup: async (workspaceId: string, groupId: string) => {
        const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
        const endpoint = endpointForWorkspaceRef.current(workspace);
        if (!endpoint) return null;
        const response = await endpoint.client.removeSessionGroup(endpoint.workspaceId, groupId);
        writeMigrationComplete(endpoint);
        return response.state;
      },
    });
    return () => setSessionGroupSyncHandler(null);
  }, []);

  useEffect(() => {
    const servers = new Map<string, { endpoint: ResolvedWorkspaceEndpoint; workspaces: RouteWorkspace[] }>();
    for (const workspace of workspacesRef.current) {
      const endpoint = endpointForWorkspaceRef.current(workspace);
      if (!endpoint) continue;
      const key = JSON.stringify([endpoint.baseUrl, endpoint.token, endpoint.hostToken]);
      const server = servers.get(key) ?? { endpoint, workspaces: [] };
      server.workspaces.push(workspace);
      servers.set(key, server);
    }
    const stops: (() => void)[] = [];
    pollers.current = [];
    for (const [serverKey, { endpoint, workspaces: serverWorkspaces }] of servers) {
      let batchSupported = true;
      const migrations = new Map<string, Promise<LegalworkSessionGroupState>>();
      const apply = async (workspace: RouteWorkspace, state: LegalworkSessionGroupState, version: number, signal: AbortSignal) => {
        const target = endpointForWorkspaceRef.current(workspace);
        if (!target || signal.aborted) return;
        let next = state;
        const local = localGroupStateForWorkspace(workspace, target);
        const ongoing = migrations.get(target.workspaceId);
        if (ongoing) next = await ongoing;
        else if (!readMigrationComplete(target) && !hasGroupData(state) && local !== undefined) {
          const migration = target.client.putSessionGroups(target.workspaceId, serverStateFromWorkspaceState(local)).then(result => result.state);
          migrations.set(target.workspaceId, migration);
          try { next = await migration; } finally { migrations.delete(target.workspaceId); }
        }
        if (signal.aborted) return;
        writeMigrationComplete(target);
        applySessionGroupServerState(workspace.id, next, version);
      };
      const poller = startRequestPolling(async signal => {
        const targets = serverWorkspaces.flatMap(workspace => {
          const target = endpointForWorkspaceRef.current(workspace);
          return target ? [{ workspace, target, key: `${serverKey}:${target.workspaceId}`, version: beginSessionGroupServerSync(workspace.id) }] : [];
        });
        if (batchSupported) {
          try {
            // Bounded URL size without limiting the number of projects synchronized.
            for (let start = 0; start < targets.length; start += 100) {
              const chunk = targets.slice(start, start + 100);
              const cursors = Object.fromEntries(chunk.map(item => [item.target.workspaceId, eventCursorByWorkspaceRef.current[item.key] ?? null]));
              const response = await endpoint.client.listSessionGroupsBatch(cursors, signal);
              const applied = await Promise.allSettled(chunk.map(async item => {
                const result = response.items.find(result => result.workspaceId === item.target.workspaceId);
                if (!result || signal.aborted) return;
                if (result.state) await apply(item.workspace, result.state, item.version, signal);
                // Advance only after applying, so a failed migration remains retryable.
                if (!signal.aborted) eventCursorByWorkspaceRef.current[item.key] = result.cursor;
              }));
              const failed = applied.find(result => result.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
            }
            return;
          } catch (error) {
            if (!(error instanceof LegalworkServerError) || ![404, 405].includes(error.status)) throw error;
            batchSupported = false;
          }
        }
        // Older workers retain their existing protocol and migration behavior.
        const results = await Promise.allSettled(targets.map(async item => {
          const since = eventCursorByWorkspaceRef.current[item.key];
          const response = await item.target.client.listSessionGroupEvents(item.target.workspaceId, { ...(typeof since === "number" ? { since } : {}), signal });
          if (signal.aborted) return;
          if (since == null || (response.cursor ?? 0) < since || response.items.length > 0) {
            const groups = await item.target.client.getSessionGroups(item.target.workspaceId, signal);
            await apply(item.workspace, groups.state, item.version, signal);
          }
          if (!signal.aborted) eventCursorByWorkspaceRef.current[item.key] = response.cursor ?? 0;
        }));
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }, { intervalMs: () => syncRef.current.live && syncRef.current.metadata && syncRef.current.baseUrl === endpoint.client.baseUrl ? 30_000 : 3000 });
      pollers.current.push(poller);
      const unsubscribe = onSyncPoke(poke => {
        if (syncRef.current.baseUrl === endpoint.client.baseUrl && (poke.groups || poke.resync)) poller.wake();
      });
      stops.push(() => { unsubscribe(); poller.stop(); });
    }
    return () => { for (const stop of stops) stop(); };
  }, [endpointKey]);
  useEffect(() => {
    const previous = previousSync.current;
    if (previous.live !== sync.live || previous.metadata !== sync.metadata || previous.baseUrl !== sync.baseUrl) for (const poller of pollers.current) poller.wake();
    previousSync.current = sync;
  }, [sync.live, sync.metadata, sync.baseUrl]);
}
