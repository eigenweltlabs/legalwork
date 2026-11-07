import type { QueryClient } from "@tanstack/react-query";

/** Drop data from the previous account, including requests ignoring abort. */
export async function resetBackOfficeCache(cache: QueryClient, baseUrl: string) {
  const roots = new Set(["back-office", "back-office-history", "back-office-projects", "bo-file-picker"]);
  const filter = { predicate: (query: { queryKey: readonly unknown[] }) =>
    roots.has(String(query.queryKey[0])) && query.queryKey[1] === baseUrl };
  await cache.cancelQueries(filter);
  await cache.resetQueries(filter);
}
