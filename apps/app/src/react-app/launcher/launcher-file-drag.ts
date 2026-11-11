import { useRef, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { launcherFilesPrepareDrag, launcherFilesStartDrag } from "@/app/lib/desktop";
import { t } from "@/i18n";
import { launcherActionSelection } from "./action-catalog";
import { resultKey } from "./launcher-search-session";
import { useLauncherShell } from "./launcher-shell";
import { useLauncherStore } from "./launcher-store";

/** Warm native file references while results are visible, not after a drag has begun. */
export function useLauncherFileDrag(items: LauncherSearchResult[], enabled: boolean, focused?: LauncherSearchResult) {
  const { client } = useLauncherShell();
  const queryClient = useQueryClient();
  const suppressNextClick = useRef(false);
  const multiSelect = useLauncherStore(state => state.multiSelect);
  const available = [...new Map(items.filter(item => item.kind === "files" && (item.workspaceId || item.folderId)).map(item => [resultKey(item), item])).values()];
  const candidates = [...available.filter(item => multiSelect.has(resultKey(item)) || focused && resultKey(focused) === resultKey(item)), ...available.filter(item => !multiSelect.has(resultKey(item)) && (!focused || resultKey(focused) !== resultKey(item)))].slice(0, 100).sort((a, b) => resultKey(a).localeCompare(resultKey(b)));
  const queryKey = ["launcher-file-drag", client.baseUrl, candidates.map(item => [resultKey(item), item.path, item.fileType])];
  const prepared = useQuery({
    queryKey,
    enabled: enabled && candidates.length > 0,
    staleTime: 15_000, refetchInterval: enabled ? 30_000 : false, retry: false,
    queryFn: async ({ signal }) => {
      const { items: visible } = await client.visibleLauncherFiles(candidates.map(({ excerpt: _excerpt, sources: _sources, ...item }) => item), signal);
      const live = candidates.filter(item => visible.some(found => resultKey(found) === resultKey(item)));
      if (!live.length) return new Map<string, string>();
      const [workspaces, folders] = await Promise.all([
        live.some(item => item.workspaceId && !item.folderId) ? client.listWorkspaces() : null,
        live.some(item => item.folderId) ? client.launcherFolders() : null,
      ]);
      signal.throwIfAborted();
      const files = live.flatMap(item => {
        const root = item.folderId ? folders?.folders.find(folder => folder.id === item.folderId)?.path
          : (workspaces?.items ?? workspaces?.workspaces ?? []).find(workspace => workspace.id === item.workspaceId)?.path;
        return root ? [{ key: resultKey(item), root, path: `${root.replace(/[\\/]+$/, "")}/${item.path ?? item.id}` }] : [];
      });
      const tokens = new Map((await launcherFilesPrepareDrag(client.baseUrl, files.map(({ path, root }) => ({ path, root })))).map(item => [item.path, item.token]));
      signal.throwIfAborted();
      return new Map(files.flatMap(item => { const token = tokens.get(item.path); return token ? [[item.key, token]] : []; }));
    },
  });
  const canDrag = (item: LauncherSearchResult) => enabled && Date.now() - prepared.dataUpdatedAt < 50_000 && Boolean(prepared.data?.has(resultKey(item)));
  const start = (event: DragEvent<HTMLElement>, item: LauncherSearchResult) => {
    event.preventDefault(); event.stopPropagation();
    const selection = launcherActionSelection(item, available, useLauncherStore.getState().multiSelect);
    if (selection.length > 100) {
      useLauncherStore.getState().notify({ tone: "error", text: t("launcher.drag.selection_limit") });
      return;
    }
    const tokens = selection.map(file => prepared.data?.get(resultKey(file)));
    if (!enabled || tokens.some(token => !token)) {
      useLauncherStore.getState().notify({ tone: "info", text: t("launcher.drag.preparing") });
      void prepared.refetch();
      return;
    }
    // Remove single-use handles before dispatch, including from a cached view we may revisit.
    queryClient.setQueryData<Map<string, string>>(queryKey, current => {
      const remaining = new Map(current);
      selection.forEach(file => remaining.delete(resultKey(file)));
      return remaining;
    });
    suppressNextClick.current = true;
    void launcherFilesStartDrag(tokens.filter((token): token is string => Boolean(token)))
      .catch(() => useLauncherStore.getState().notify({ tone: "error", text: t("launcher.drag.failed") }))
      .finally(() => { void queryClient.invalidateQueries({ queryKey, exact: true }); });
  };
  return { canDrag, start, resetClickSuppression: () => { suppressNextClick.current = false; }, suppressClick: () => { const suppress = suppressNextClick.current; suppressNextClick.current = false; return suppress; } };
}
