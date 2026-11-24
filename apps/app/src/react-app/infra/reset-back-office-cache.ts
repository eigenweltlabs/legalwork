import type { SyncPoke } from "@legalwork/types/sync-events";
import type { QueryClient } from "@tanstack/react-query";

/** Engine configuration can reload repeatedly at startup. A changed access policy
 * must revoke cached rows immediately, while ordinary directory writes only refetch. */
export async function syncBackOfficeCache(cache: QueryClient, baseUrl: string, poke: SyncPoke) {
  if (!poke.policy) {
    if (poke.backOffice || poke.resync) {
      await cache.invalidateQueries({ queryKey: ["back-office", baseUrl] }, { cancelRefetch: false });
    }
    return;
  }
  const roots = new Set(["back-office", "back-office-history", "back-office-projects", "bo-file-picker", "time-tracking-settings", "time-tracking-profile", "timekeeping-conversation"]);
  const filter = { predicate: (query: { queryKey: readonly unknown[]; meta?: Record<string, unknown> }) =>
    (roots.has(String(query.queryKey[0])) || query.meta?.liveBackOffice === true) && query.queryKey[1] === baseUrl };
  await cache.cancelQueries(filter);
  await cache.resetQueries(filter);
}
