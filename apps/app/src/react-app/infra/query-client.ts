import { QueryClient } from "@tanstack/react-query";

type QueryClientGlobal = typeof globalThis & {
  __owReactQueryClient?: QueryClient;
};

export function getReactQueryClient(): QueryClient {
  const target = globalThis as QueryClientGlobal;
  const queryClient = target.__owReactQueryClient ?? new QueryClient();

  for (const queryKey of [
    ["react-session-transcript"],
    ["react-session-status"],
  ] as const) {
    queryClient.setQueryDefaults(queryKey, { gcTime: 15_000 });
  }

  // Plans, pending permissions and questions are written with setQueryData only and
  // observed through a raw cache subscription, so the query has zero
  // observers and TanStack GC removes it ~15s after creation. That made the
  // permission dialog auto-dismiss with no resolution while the tool call
  // stayed "running" forever (#1916). They are cleared explicitly by
  // reply events, authoritative snapshots, and session deletion,
  // never by GC.
  for (const queryKey of [
    ["react-session-todos"],
    ["react-session-permissions"],
    ["react-session-questions"],
    ["react-interaction-sessions"],
  ] as const) {
    queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  }
  // Also repair plans created before a dev hot update; preserve the shared
  // cache/client and all user state rather than waiting for an app restart.
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["react-session-todos"] })) {
    if (query.gcTime !== Infinity) {
      // setOptions changes the deadline but does not clear an already scheduled
      // GC timer. These setQueryData-only entries have no fetch to interrupt.
      query.destroy();
      query.setOptions({ ...query.options, gcTime: Infinity });
    }
  }

  target.__owReactQueryClient = queryClient;
  return target.__owReactQueryClient;
}
