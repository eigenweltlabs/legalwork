/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { STORAGE_PAGE_SIZE, type StorageEntry, type StorageRoot } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactIcon } from "../artifacts/artifact-icon";
import { classifyOpenTarget } from "../artifacts/open-target";

type Props = {
  client: LegalworkServerClient;
  workspaceId: string;
  roots: StorageRoot[];
  query: string;
  refreshKey: number | string;
  onOpenFile: (root: StorageRoot, file: StorageEntry) => void;
};

export function StorageDriveSearch(props: Props) {
  return (
    <div className="p-2">
      {props.roots.map((root) => (
        <ConnectionSearch key={root.id} {...props} root={root} />
      ))}
    </div>
  );
}

function ConnectionSearch({
  client,
  workspaceId,
  root,
  query,
  refreshKey,
  onOpenFile,
}: Omit<Props, "roots"> & { root: StorageRoot }) {
  const [visibleLimit, setVisibleLimit] = useState(STORAGE_PAGE_SIZE);
  const search = useInfiniteQuery({
    queryKey: ["storage-filename-search", workspaceId, root.id, query, refreshKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.storageFilenameSearch(workspaceId, root.id, { query, path: "", cursor: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const entries = [
    ...new Map((search.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => [entry.path, entry])).values(),
  ];
  const scanned = search.data?.pages.reduce((count, page) => count + page.scanned, 0) ?? 0;
  const continuing = Boolean(search.hasNextPage && entries.length < visibleLimit && !search.isError);
  // Empty listing pages are progress, not "no matches". Keep scanning until the
  // source is exhausted or a display page is ready; changing the query cancels it.
  useEffect(() => {
    if (continuing && !search.isFetching) void search.fetchNextPage();
  }, [continuing, search.isFetching, search.fetchNextPage]);
  const loading = search.isFetching || continuing;
  return (
    <section aria-label={root.name} className="pb-2">
      <h3 className="truncate px-2 py-2 text-xs font-medium text-muted-foreground">{root.name}</h3>
      {entries.slice(0, visibleLimit).map((entry) => (
        <button
          key={entry.path}
          type="button"
          title={`${root.name} / ${entry.displayPath ?? entry.path}`}
          onClick={() => onOpenFile(root, entry)}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ArtifactIcon type={classifyOpenTarget(entry.name, "file")} className="size-5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">{entry.name}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{entry.displayPath ?? entry.path}</span>
          </span>
        </button>
      ))}
      {loading ? (
        <p role="status" className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          {t("storage.search_progress", { count: scanned.toLocaleString() })}
        </p>
      ) : null}
      {search.isError ? (
        <div role="alert" className="px-2 py-2 text-xs text-destructive">
          <p className="break-words">{search.error.message}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void (search.hasNextPage ? search.fetchNextPage() : search.refetch())}
          >
            {t("storage.retry")}
          </Button>
        </div>
      ) : null}
      {!loading && !search.isError && entries.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">{t("legalmemory.no_matches")}</p>
      ) : null}
      {!loading && !search.isError && (search.hasNextPage || entries.length > visibleLimit) ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => setVisibleLimit((limit) => limit + STORAGE_PAGE_SIZE)}
        >
          {t("storage.load_more")}
        </Button>
      ) : null}
    </section>
  );
}
