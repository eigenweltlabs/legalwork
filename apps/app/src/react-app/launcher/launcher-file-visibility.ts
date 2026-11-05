import { useQuery } from "@tanstack/react-query";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { useLauncherShell } from "./launcher-shell";
import { resultKey } from "./launcher-search-session";

/** Recent-use metadata is not proof that a file still exists. */
export function useLauncherFileVisibility(items: LauncherSearchResult[], visible: boolean) {
  const { client } = useLauncherShell();
  const candidates = [...new Map(items.filter(item => item.kind === "files").map(item => [resultKey(item), item])).values()];
  return useQuery({ queryKey: ["launcher-existing-files", client.baseUrl, candidates.map(item => [resultKey(item), item.path, item.fileType])],
    enabled: visible && candidates.length > 0, staleTime: 0, refetchInterval: visible ? 2000 : false, refetchOnWindowFocus: "always",
    queryFn: async ({ signal }) => {
      const keys = new Set<string>();
      for (let offset = 0; offset < candidates.length; offset += 100) {
        const batch = candidates.slice(offset, offset + 100).map(({ excerpt: _excerpt, sources: _sources, ...item }) => item);
        const result = await client.visibleLauncherFiles(batch, signal);
        result.items.forEach(item => keys.add(resultKey(item)));
      }
      return keys;
    },
  });
}
