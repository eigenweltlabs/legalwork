/** @jsxImportSource react */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronRight, Eye, EyeOff, RotateCw, X } from "lucide-react";

import type {
  LegalworkServerClient,
  LegalworkWorkspaceDirectoryEntry,
  LegalworkWorkspaceDirectoryList,
} from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatFileSize } from "@/lib/utils";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { PanelEmptyState, PanelHeader } from "@/react-app/design-system/panel-chrome";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { classifyOpenTarget } from "../artifacts/open-target";

type WorkspaceFilesPanelProps = {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onClose: () => void;
};

const SKELETON_ROW_WIDTHS = ["56%", "72%", "44%", "64%", "38%", "52%"];

// The panel unmounts whenever the user switches to the preview or another rail
// pane; remember the folder per workspace so reopening lands where they left off.
const lastPathByWorkspace = new Map<string, string>();

function workspaceDisplayName(workspaceRoot: string): string {
  const cleaned = workspaceRoot.trim().replace(/[/\\]+$/, "");
  const name = cleaned.split(/[/\\]/).filter(Boolean).pop();
  return name || "Workspace";
}

export function WorkspaceFilesPanel({
  client,
  workspaceId,
  workspaceRoot,
  onOpenFile,
  onClose,
}: WorkspaceFilesPanelProps) {
  const [path, setPath] = React.useState(() => (workspaceId ? lastPathByWorkspace.get(workspaceId) ?? "" : ""));
  const [showHidden, setShowHidden] = React.useState(false);

  React.useEffect(() => {
    if (workspaceId) {
      lastPathByWorkspace.set(workspaceId, path);
    }
  }, [path, workspaceId]);
  const breadcrumbsRef = React.useRef<HTMLElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const { data, error, isError, isLoading, isFetching, refetch } = useQuery<LegalworkWorkspaceDirectoryList>({
    queryKey: ["workspace-files", workspaceId, path] as const,
    queryFn: async () => {
      if (!client || !workspaceId) {
        throw new Error("Workspace is not connected.");
      }
      return client.listWorkspaceDirectory(workspaceId, path);
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const crumbs = React.useMemo(() => {
    const segments = path.split("/").filter(Boolean);
    return [
      { label: workspaceDisplayName(workspaceRoot), path: "" },
      ...segments.map((segment, index) => ({
        label: segment,
        path: segments.slice(0, index + 1).join("/"),
      })),
    ];
  }, [path, workspaceRoot]);

  const visibleEntries = React.useMemo(() => {
    const entries = data?.entries ?? [];
    return showHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."));
  }, [data?.entries, showHidden]);

  const hiddenCount = (data?.entries.length ?? 0) - visibleEntries.length;

  // Deep paths overflow the breadcrumb bar; keep the current folder in view.
  React.useEffect(() => {
    breadcrumbsRef.current?.scrollTo({ left: breadcrumbsRef.current.scrollWidth });
  }, [path]);

  const navigateTo = React.useCallback((nextPath: string) => {
    setPath(nextPath);
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  return (
    <TooltipProvider delay={1000}>
      <div className="flex h-full min-h-0 flex-col bg-background/90">
        <PanelHeader title="Files" icon={<FolderIcon open />}>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowHidden((value) => !value)}
                  aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
                  aria-pressed={showHidden}
                >
                  {showHidden ? <EyeOff /> : <Eye />}
                </Button>
              )}
            />
            <TooltipContent>{showHidden ? "Hide hidden files" : "Show hidden files"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void refetch()}
                  disabled={isFetching}
                  aria-label="Refresh folder"
                >
                  <RotateCw className={cn(isFetching && "animate-spin")} />
                </Button>
              )}
            />
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close files panel">
                  <X />
                </Button>
              )}
            />
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </PanelHeader>

        <nav
          ref={breadcrumbsRef}
          aria-label="Current folder"
          className="no-scrollbar flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap border-b border-border/50 bg-muted/20 px-2.5"
        >
          {crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1;
            return (
              <React.Fragment key={crumb.path || "__workspace_root__"}>
                {index > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" /> : null}
                <button
                  type="button"
                  onClick={() => navigateTo(crumb.path)}
                  disabled={current}
                  aria-current={current ? "location" : undefined}
                  className={cn(
                    "shrink-0 rounded-md px-1.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    current
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <div className="space-y-0.5">
              {SKELETON_ROW_WIDTHS.map((width, index) => (
                <div key={index} className="flex items-center gap-2.5 px-2.5 py-2">
                  <Skeleton className="size-5 shrink-0 rounded-md" />
                  <Skeleton className="h-3.5 rounded" style={{ width }} />
                </div>
              ))}
            </div>
          ) : isError ? (
            <PanelEmptyState
              icon={<AlertCircle />}
              title="Unable to open this folder"
              description={error instanceof Error ? error.message : "Failed to load this folder."}
            >
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
            </PanelEmptyState>
          ) : visibleEntries.length === 0 ? (
            <PanelEmptyState icon={<FolderIcon open />} title="This folder is empty" description="Files you add to this folder will appear here.">
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => setShowHidden(true)}
                >
                  Show {hiddenCount} hidden {hiddenCount === 1 ? "item" : "items"}
                </button>
              ) : null}
            </PanelEmptyState>
          ) : (
            <>
              {visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => (entry.kind === "dir" ? navigateTo(entry.path) : onOpenFile(entry))}
                  title={entry.name}
                  className="group flex min-h-9 w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border/50 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                >
                  {entry.kind === "dir" ? (
                    <FolderIcon />
                  ) : (
                    <ArtifactIcon type={classifyOpenTarget(entry.name, "file")} className="size-5" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{entry.name}</span>
                  {entry.kind === "dir" ? (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                  ) : entry.size !== undefined ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatFileSize(entry.size)}
                    </span>
                  ) : null}
                </button>
              ))}
              {data?.truncated ? (
                <p className="px-2.5 py-2 text-center text-[11px] text-muted-foreground/70">
                  This folder has more entries than can be shown.
                </p>
              ) : null}
              {!showHidden && hiddenCount > 0 ? (
                <button
                  type="button"
                  className="w-full rounded-md px-2.5 py-2 text-center text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                  onClick={() => setShowHidden(true)}
                >
                  {hiddenCount} hidden {hiddenCount === 1 ? "item" : "items"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
