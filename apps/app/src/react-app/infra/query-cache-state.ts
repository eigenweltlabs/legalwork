import { useCallback, useSyncExternalStore } from "react";
import { notifyManager } from "@tanstack/react-query";

import { getReactQueryClient } from "./query-client";

/**
 * Subscribe to a TanStack Query cache entry as plain external state.
 * Pass a null key to pin the fallback (used while route params are missing).
 */
export function useQueryCacheState<T>(queryKey: readonly unknown[] | null, fallback: T): T {
  const queryClient = getReactQueryClient();
  const queryCache = queryClient.getQueryCache();
  const queryHash = queryKey ? queryClient.defaultQueryOptions({ queryKey }).queryHash : null;
  const subscribe = useCallback((onChange: () => void) => {
    if (queryHash === null) return () => {};
    const notify = notifyManager.batchCalls(onChange);
    return queryCache.subscribe(event => {
      if (event.query.queryHash === queryHash &&
          (event.type === "added" || event.type === "updated" || event.type === "removed")) notify();
    });
  }, [queryCache, queryHash]);
  return useSyncExternalStore(
    subscribe,
    () => (queryKey ? queryClient.getQueryData<T>(queryKey) ?? fallback : fallback),
    () => fallback,
  );
}
