/** @jsxImportSource react */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ChevronRight, Folder, FolderOpen, HardDrive, Loader2, RotateCw, Search, X } from "lucide-react";

import { writeLegalMemoryFileDrag } from "@/app/lib/legalmemory-file";
import { LEGALMEMORY_CONNECTION_CHANGED_EVENT } from "@/app/lib/legalmemory-connection";
import {
  LegalworkServerError,
  type LegalMemoryTreeFile,
  type LegalMemoryTreeFolder,
  type LegalMemoryTreePage,
  type LegalMemoryTreeRoot,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatFileSize } from "@/lib/utils";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { classifyOpenTarget } from "../artifacts/open-target";

const PAGE_SIZE = 200;
const ROW_HEIGHT = 32;

type FolderState = {
  status: "idle" | "loading" | "error";
  folders: LegalMemoryTreeFolder[];
  files: LegalMemoryTreeFile[];
  total: number;
  error?: string;
};

type TreeRow =
  | { kind: "root"; key: string; depth: number; root: LegalMemoryTreeRoot; open: boolean }
  | { kind: "folder"; key: string; depth: number; sourceId: string; folder: LegalMemoryTreeFolder; open: boolean }
  | { kind: "file"; key: string; depth: number; file: LegalMemoryTreeFile; searchResult: boolean }
  | { kind: "more"; key: string; depth: number; sourceId: string; path: string; loaded: number; remaining: number }
  | { kind: "status"; key: string; depth: number; label: string; spinning?: boolean };

type LegalMemoryFilesPanelProps = {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  onOpenFile: (file: LegalMemoryTreeFile) => Promise<void> | void;
  onConnectLegalMemory?: () => void;
  onClose: () => void;
};

const folderKey = (sourceId: string, path: string) => `${sourceId}:${path}`;

export function LegalMemoryFilesPanel({
  client,
  workspaceId,
  onOpenFile,
  onConnectLegalMemory,
  onClose,
}: LegalMemoryFilesPanelProps) {
  const [openFolders, setOpenFolders] = React.useState<Set<string>>(new Set());
  const [folders, setFolders] = React.useState<Map<string, FolderState>>(new Map());
  const [query, setQuery] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [openingId, setOpeningId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const foldersRef = React.useRef(folders);
  foldersRef.current = folders;
  const openFoldersRef = React.useRef(openFolders);
  openFoldersRef.current = openFolders;

  React.useEffect(() => {
    const resetDisconnectedTree = () => {
      setOpenFolders(new Set());
      setFolders(new Map());
      setQuery("");
      setSearchQuery("");
      setSelectedId(null);
      setOpeningId(null);
    };

    window.addEventListener(LEGALMEMORY_CONNECTION_CHANGED_EVENT, resetDisconnectedTree);
    return () => window.removeEventListener(LEGALMEMORY_CONNECTION_CHANGED_EVENT, resetDisconnectedTree);
  }, []);

  const rootsQuery = useQuery({
    queryKey: ["legalmemory-tree-roots", workspaceId] as const,
    queryFn: async () => {
      if (!client || !workspaceId) throw new Error("Workspace is not connected.");
      return client.legalMemoryTreeRoots(workspaceId);
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    queryKey: ["legalmemory-tree-search", workspaceId, searchQuery] as const,
    queryFn: async () => {
      if (!client || !workspaceId) throw new Error("Workspace is not connected.");
      return client.legalMemoryTreeSearch(workspaceId, { query: searchQuery, limit: 100 });
    },
    enabled: Boolean(client && workspaceId && searchQuery),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const loadPage = React.useCallback(async (sourceId: string, path: string, offset: number) => {
    if (!client || !workspaceId) return;
    const key = folderKey(sourceId, path);
    setFolders((current) => {
      const next = new Map(current);
      const existing = next.get(key);
      next.set(key, {
        status: "loading",
        folders: existing?.folders ?? [],
        files: existing?.files ?? [],
        total: existing?.total ?? 0,
      });
      return next;
    });
    try {
      const page: LegalMemoryTreePage = await client.legalMemoryTreeChildren(workspaceId, {
        source_id: sourceId,
        path: path || undefined,
        offset,
        limit: PAGE_SIZE,
      });
      setFolders((current) => {
        const next = new Map(current);
        const existing = next.get(key);
        const files = offset > 0 ? [...(existing?.files ?? []), ...page.files] : page.files;
        next.set(key, {
          status: "idle",
          folders: page.folders,
          files,
          total: page.pagination.total,
        });
        return next;
      });
    } catch (error) {
      setFolders((current) => {
        const next = new Map(current);
        const existing = next.get(key);
        next.set(key, {
          status: "error",
          folders: existing?.folders ?? [],
          files: existing?.files ?? [],
          total: existing?.total ?? 0,
          error: error instanceof Error ? error.message : "Folder listing failed.",
        });
        return next;
      });
    }
  }, [client, workspaceId]);

  const toggleFolder = React.useCallback((sourceId: string, path: string) => {
    const key = folderKey(sourceId, path);
    const wasOpen = openFoldersRef.current.has(key);
    setOpenFolders((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    if (!wasOpen && !foldersRef.current.has(key)) void loadPage(sourceId, path, 0);
  }, [loadPage]);

  const rows = React.useMemo<TreeRow[]>(() => {
    if (searchQuery) {
      if (search.isLoading || search.isFetching) {
        return [{ kind: "status", key: "search-loading", depth: 0, label: "Searching files…", spinning: true }];
      }
      if (search.isError) {
        return [{ kind: "status", key: "search-error", depth: 0, label: search.error instanceof Error ? search.error.message : "Search failed." }];
      }
      const files = search.data?.files ?? [];
      if (!files.length) return [{ kind: "status", key: "search-empty", depth: 0, label: "No matching files" }];
      return files.map((file) => ({
        kind: "file",
        key: `${file.source_id}:${file.source_object_id}`,
        depth: 0,
        file,
        searchResult: true,
      }));
    }

    const roots = rootsQuery.data?.roots ?? [];
    const next: TreeRow[] = [];
    const walk = (sourceId: string, path: string, depth: number) => {
      const key = folderKey(sourceId, path);
      const state = folders.get(key);
      if (!state) {
        next.push({ kind: "status", key: `${key}:loading`, depth, label: "Loading…", spinning: true });
        return;
      }
      if (state.status === "error") {
        next.push({ kind: "status", key: `${key}:error`, depth, label: state.error ?? "Folder listing failed." });
        return;
      }
      if (state.status === "loading" && state.folders.length === 0 && state.files.length === 0) {
        next.push({ kind: "status", key: `${key}:loading`, depth, label: "Loading…", spinning: true });
        return;
      }
      for (const folder of state.folders) {
        const childKey = folderKey(sourceId, folder.path);
        const isOpen = openFolders.has(childKey);
        next.push({ kind: "folder", key: childKey, depth, sourceId, folder, open: isOpen });
        if (isOpen) walk(sourceId, folder.path, depth + 1);
      }
      for (const file of state.files) {
        next.push({ kind: "file", key: file.source_object_id, depth, file, searchResult: false });
      }
      if (state.status === "loading") {
        next.push({ kind: "status", key: `${key}:paging`, depth, label: "Loading…", spinning: true });
      } else if (state.files.length < state.total) {
        next.push({
          kind: "more",
          key: `${key}:more`,
          depth,
          sourceId,
          path,
          loaded: state.files.length,
          remaining: state.total - state.files.length,
        });
      }
    };

    for (const root of roots) {
      const key = folderKey(root.source_id, "");
      const isOpen = openFolders.has(key);
      next.push({ kind: "root", key, depth: 0, root, open: isOpen });
      if (isOpen) walk(root.source_id, "", 1);
    }
    return next;
  }, [folders, openFolders, rootsQuery.data?.roots, search.data?.files, search.error, search.isError, search.isFetching, search.isLoading, searchQuery]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const openFile = React.useCallback((file: LegalMemoryTreeFile) => {
    if (openingId) return;
    setOpeningId(file.source_object_id);
    void Promise.resolve()
      .then(() => onOpenFile(file))
      .then(() => setSelectedId(file.source_object_id))
      .catch(() => undefined)
      .finally(() => setOpeningId(null));
  }, [onOpenFile, openingId]);

  const refresh = React.useCallback(() => {
    setOpenFolders(new Set());
    setFolders(new Map());
    void rootsQuery.refetch();
    if (searchQuery) void search.refetch();
  }, [rootsQuery, search, searchQuery]);

  const roots = rootsQuery.data?.roots ?? [];
  const totalFiles = roots.reduce((sum, root) => sum + root.files, 0);
  const totalsKnown = roots.every((root) => !root.source_id.startsWith("__legalmemory_mcp__:"));
  const initialLoading = rootsQuery.isLoading && !rootsQuery.data;
  const initialError = rootsQuery.isError && !rootsQuery.data;
  const notConfigured = rootsQuery.error instanceof LegalworkServerError
    && rootsQuery.error.code === "legalmemory_not_configured";

  return (
    <TooltipProvider delay={800}>
      <aside className="flex h-full w-[300px] min-w-[260px] max-w-[34vw] shrink-0 flex-col border-r border-border bg-background mac:bg-background/90 mac:backdrop-blur-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 mac:titlebar-no-drag">
          <FolderOpen className="size-4 shrink-0 text-indigo-10" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">Memory Drive</h2>
          {rootsQuery.data && totalsKnown ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">{totalFiles.toLocaleString()}</span>
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh Memory Drive" />}>
              <RotateCw className={cn("size-3.5", (rootsQuery.isFetching || search.isFetching) && "animate-spin")} />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Memory Drive" />}>
              <X className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>

        {!notConfigured ? <div className="shrink-0 border-b border-border/60 p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search filenames"
              aria-label="Search LegalMemory files"
              className="h-8 w-full rounded-lg border border-input bg-muted/30 pl-8 pr-8 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div> : null}

        {notConfigured ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <HardDrive className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Connect LegalMemory</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Connect your firm’s knowledge index to browse its files here.
              </p>
            </div>
            {onConnectLegalMemory ? (
              <Button variant="outline" size="sm" onClick={onConnectLegalMemory}>Open Integrations</Button>
            ) : null}
          </div>
        ) : initialLoading ? (
          <div className="space-y-1 p-3">
            {["62%", "78%", "51%", "70%", "45%", "66%"].map((width, index) => (
              <div key={index} className="flex h-8 items-center gap-2">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-3.5 rounded" style={{ width }} />
              </div>
            ))}
          </div>
        ) : initialError ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertCircle className="size-7 text-muted-foreground/50" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground">
              {rootsQuery.error instanceof Error ? rootsQuery.error.message : "Could not load LegalMemory."}
            </p>
            <Button variant="outline" size="sm" onClick={() => void rootsQuery.refetch()}>Try again</Button>
          </div>
        ) : roots.length === 0 && !searchQuery ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FolderOpen className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground">No indexed files are available</p>
          </div>
        ) : (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1.5">
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <LegalMemoryTreeRow
                      row={row}
                      selectedId={selectedId}
                      openingId={openingId}
                      onToggle={toggleFolder}
                      onOpen={openFile}
                      onLoadMore={loadPage}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>
    </TooltipProvider>
  );
}

function LegalMemoryTreeRow({
  row,
  selectedId,
  openingId,
  onToggle,
  onOpen,
  onLoadMore,
}: {
  row: TreeRow;
  selectedId: string | null;
  openingId: string | null;
  onToggle: (sourceId: string, path: string) => void;
  onOpen: (file: LegalMemoryTreeFile) => void;
  onLoadMore: (sourceId: string, path: string, offset: number) => void;
}) {
  const inset = { paddingLeft: 9 + row.depth * 15 };
  if (row.kind === "status") {
    return (
      <div style={inset} className="flex min-h-8 items-center gap-2 pr-3 text-xs text-muted-foreground">
        {row.spinning ? <Loader2 className="size-3 animate-spin" /> : <AlertCircle className="size-3" />}
        <span className="truncate">{row.label}</span>
      </div>
    );
  }
  if (row.kind === "more") {
    return (
      <button
        type="button"
        style={inset}
        onClick={() => onLoadMore(row.sourceId, row.path, row.loaded)}
        className="flex min-h-8 w-full items-center pr-3 text-left text-xs text-indigo-10 hover:underline"
      >
        Show {Math.min(PAGE_SIZE, row.remaining).toLocaleString()} more
      </button>
    );
  }
  if (row.kind === "root") {
    return (
      <button
        type="button"
        style={inset}
        aria-expanded={row.open}
        onClick={() => onToggle(row.root.source_id, "")}
        className="group flex min-h-8 w-full items-center gap-1.5 pr-3 text-left hover:bg-muted/60"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.open && "rotate-90")} />
        {row.open ? <FolderOpen className="size-4 shrink-0 fill-indigo-4/30 text-indigo-10" /> : <Folder className="size-4 shrink-0 fill-indigo-4/20 text-indigo-10" />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{row.root.display_name}</span>
        {!row.root.source_id.startsWith("__legalmemory_mcp__:") ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{row.root.files.toLocaleString()}</span>
        ) : null}
      </button>
    );
  }
  if (row.kind === "folder") {
    return (
      <button
        type="button"
        style={inset}
        aria-expanded={row.open}
        onClick={() => onToggle(row.sourceId, row.folder.path)}
        title={row.folder.path}
        className="group flex min-h-8 w-full items-center gap-1.5 pr-3 text-left hover:bg-muted/60"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.open && "rotate-90")} />
        {row.open ? <FolderOpen className="size-4 shrink-0 fill-sky-4/30 text-sky-10" /> : <Folder className="size-4 shrink-0 fill-sky-4/20 text-sky-10" />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{row.folder.name}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground opacity-0 group-hover:opacity-100">{row.folder.files.toLocaleString()}</span>
      </button>
    );
  }

  const selected = selectedId === row.file.source_object_id;
  const opening = openingId === row.file.source_object_id;
  return (
    <button
      type="button"
      draggable
      style={inset}
      onDragStart={(event) => writeLegalMemoryFileDrag(event.dataTransfer, row.file)}
      onClick={() => onOpen(row.file)}
      title={row.file.path}
      className={cn(
        "group relative flex min-h-8 w-full items-center gap-2 pr-3 text-left transition-colors",
        selected ? "bg-indigo-3/60" : "hover:bg-muted/60",
      )}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-0.5 bg-indigo-9" /> : null}
      <span className="ml-[15px] flex size-4 shrink-0 items-center justify-center">
        {opening ? <Loader2 className="size-3.5 animate-spin text-indigo-10" /> : <ArtifactIcon type={classifyOpenTarget(row.file.name, "file")} className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[13px]", selected ? "font-medium text-foreground" : "text-foreground/90")}>{row.file.name}</span>
        {row.searchResult ? <span className="block truncate text-[10px] text-muted-foreground">{row.file.path}</span> : null}
      </span>
      {!row.searchResult && row.file.size_bytes !== null ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground opacity-0 group-hover:opacity-100">
          {formatFileSize(row.file.size_bytes)}
        </span>
      ) : null}
    </button>
  );
}
