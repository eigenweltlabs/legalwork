import { useProjectFiles } from "../../workspace/project-file-context";
import { ProjectFileDropTarget } from "../../workspace/project-file-transfer";
import { ProjectLinkedFiles } from "../../workspace/project-linked-files";
/** @jsxImportSource react */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Pin, ChevronRight, Eye, EyeOff, RotateCw, Search, X } from "lucide-react";

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

import { useFilePins } from "./file-pins";
import { WorkspaceEntryMenu } from "./workspace-entry-menu";


import { ArtifactIcon } from "../artifacts/artifact-icon";
import { classifyOpenTarget } from "../artifacts/open-target";
import { projectFileDisplayName } from "../../workspace/project-note-title";
import { writeWorkspaceFileDrag } from "@/app/lib/workspace-file-drag";
import { t } from "@/i18n";
import { projectErrorMessage } from "../../workspace/project-errors";
import { ProjectFilesDropzone } from "../../workspace/project-files-dropzone";

type WorkspaceFilesPanelProps = {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  projectName?: string;
  headerTarget?: HTMLElement | null;
  isRemoteWorkspace: boolean;
  active: boolean;
  searchable?: boolean;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry, permanent?: boolean) => void;
  onClose?: () => void;
};

const SKELETON_ROW_WIDTHS = ["56%", "72%", "44%", "64%", "38%", "52%"];

// Remember the folder when navigating away from a workspace and back.
const lastPathByWorkspace = new Map<string, string>();

function workspaceDisplayName(workspaceRoot: string): string {
  const cleaned = workspaceRoot.trim().replace(/[/\\]+$/, "");
  const name = cleaned.split(/[/\\]/).filter(Boolean).pop();
  return name || "Workspace";
}

export function WorkspaceFilesPanel(props: WorkspaceFilesPanelProps) {
  return <WorkspaceFilesPanelContent key={`${props.client?.baseUrl}:${props.workspaceId}`} {...props} />;
}

function WorkspaceFilesPanelContent({
  client,
  workspaceId,
  workspaceRoot,
  projectName,
  headerTarget,
  isRemoteWorkspace,
  active,
  searchable = false,
  onOpenFile,
  onClose,
}: WorkspaceFilesPanelProps) {
  const scope = `${client?.baseUrl}:${workspaceId}`;
  const projectFiles = useProjectFiles();
  const projectId = client && workspaceId ? projectFiles?.identify(client, workspaceId, { path: "_", name: "_" })?.projectId : undefined;
  const pins = useFilePins().filter(pin => pin.workspaceId === workspaceId && pin.source === "local");
  const [path, setPath] = React.useState(() => (workspaceId ? lastPathByWorkspace.get(scope) ?? "" : ""));
  const [showHidden, setShowHidden] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const searching = searchable && Boolean(query.trim());
  const search = useQuery({
    queryKey: ["project-file-search", workspaceId, searchQuery, client?.baseUrl],
    queryFn: ({ signal }) => client!.searchContents(workspaceId!, "files", searchQuery, signal),
    enabled: Boolean(searchable && active && client && workspaceId && searchQuery),
    staleTime: 15_000,
  });


  React.useEffect(() => {
    if (workspaceId) {
      lastPathByWorkspace.set(scope, path);
    }
  }, [path, workspaceId, scope]);
  const breadcrumbsRef = React.useRef<HTMLElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const { data, error, isError, isLoading, isFetching, refetch } = useQuery<LegalworkWorkspaceDirectoryList>({
    queryKey: ["workspace-files", workspaceId, path, client?.baseUrl] as const,
    queryFn: async () => {
      if (!client || !workspaceId) {
        throw new Error(t("workspace_files.not_connected"));
      }
      return client.listWorkspaceDirectory(workspaceId, path);
    },
    enabled: Boolean(active && client && workspaceId),
    staleTime: 15_000,
    // Agent scripts and external apps can add files without engine events.
    // Poll only the visible folder; hidden/collapsed panes retain their state.
    refetchInterval: active ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  const crumbs = React.useMemo(() => {
    const segments = path.split("/").filter(Boolean);
    return [
      { label: projectName || workspaceDisplayName(workspaceRoot), path: "" },
      ...segments.map((segment, index) => ({
        label: segment,
        path: segments.slice(0, index + 1).join("/"),
      })),
    ];
  }, [path, workspaceRoot, projectName]);

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
    setQuery("");
    setPath(nextPath);
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const renderEntry = (entry: LegalworkWorkspaceDirectoryEntry, pinned = false) => {
    const displayName = entry.kind === "file" ? projectFileDisplayName(entry.path, entry.name) : entry.name;
    return (
      <WorkspaceEntryMenu key={entry.path} client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace}
        folderPath={entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")))} entry={entry} onOpen={() => entry.kind === "dir" ? navigateTo(entry.path) : onOpenFile(entry)}
        onRefresh={() => void refetch()}>
      <button
        data-project-folder={entry.kind === "dir" ? entry.path : undefined}
        type="button"
        draggable={entry.kind === "file" && Boolean(workspaceId)}
        onDragStart={(event) => {
          if (entry.kind !== "file" || !workspaceId) { event.preventDefault(); return; }
          writeWorkspaceFileDrag(event.dataTransfer, { workspaceId, path: entry.path, name: displayName });
          if (client) projectFiles?.drag(event.dataTransfer, client, workspaceId, { path: entry.path, name: displayName });
        }}
        onClick={() => (entry.kind === "dir" ? navigateTo(entry.path) : onOpenFile(entry))}
        onDoubleClick={() => { if (entry.kind !== "dir") onOpenFile(entry, true); }}
        title={entry.path}
        className="group flex min-h-9 w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border/50 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
      >
        {entry.kind === "dir" ? (
          <FolderIcon />
        ) : (
          <ArtifactIcon type={classifyOpenTarget(entry.name, "file")} className="size-5" />
        )}
        <span className="min-w-0 flex-1 text-[13px] text-foreground"><span className="block truncate">{displayName}</span>{pinned && entry.path.includes("/") && <span className="block truncate text-[10px] text-muted-foreground">{entry.path}</span>}</span>
        {entry.kind === "dir" ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        ) : entry.size !== undefined ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatFileSize(entry.size)}
          </span>
        ) : null}
      </button>
      </WorkspaceEntryMenu>
    );
  };

  return (
    <TooltipProvider delay={1000}>
      <ProjectFileDropTarget projectId={projectId ?? ""} folder={path} className="flex h-full min-h-0 flex-1 flex-col">
      <ProjectFilesDropzone projectId={workspaceId ?? ""} workspaceId={workspaceId ?? ""} isRemoteWorkspace={isRemoteWorkspace || !client || !workspaceId} destinationPath={path}>
      <div className="flex h-full min-h-0 flex-col bg-background/90">
        <PanelHeader wrapActions headerTarget={headerTarget} title={t("workspace_files.files")}>
          <WorkspaceEntryMenu client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace}
            folderPath={path} onRefresh={() => void refetch()} toolbar />
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowHidden((value) => !value)}
                  aria-label={showHidden ? t("workspace_files.hide_hidden") : t("workspace_files.show_hidden")}
                  aria-pressed={showHidden}
                >
                  {showHidden ? <EyeOff /> : <Eye />}
                </Button>
              )}
            />
            <TooltipContent>{showHidden ? t("workspace_files.hide_hidden") : t("workspace_files.show_hidden")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void refetch()}
                  disabled={isFetching}
                  aria-label={t("workspace_files.refresh_folder")}
                >
                  <RotateCw className={cn(isFetching && "animate-spin")} />
                </Button>
              )}
            />
            <TooltipContent>{t("workspace_files.refresh_folder")}</TooltipContent>
          </Tooltip>
          {onClose ? <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("workspace_files.close_panel")}>
                  <X />
                </Button>
              )}
            />
            <TooltipContent>{t("workspace_files.close_panel")}</TooltipContent>
          </Tooltip> : null}
        </PanelHeader>

        {searchable && <div className="shrink-0 border-b border-border/70 px-3 py-2"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><input maxLength={512} className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-8 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" placeholder={t("project_browser.search_files")} aria-label={t("project_browser.search_files")} value={query} onChange={event => setQuery(event.target.value)} />{query && <Button variant="ghost" size="icon-xs" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery("")} aria-label={t("legalmemory.clear_search")}><X className="size-3.5" /></Button>}</div></div>}
        <nav
          ref={breadcrumbsRef}
          aria-label={t("workspace_files.current_folder")}
          className="no-scrollbar flex h-(--lw-panel-toolbar-height) shrink-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap border-b border-border/70 bg-background/80 px-2.5 backdrop-blur-xl"
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

        <WorkspaceEntryMenu client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace}
          folderPath={path} onRefresh={() => void refetch()} className="flex min-h-0 flex-1 flex-col" contextOnly>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {client && workspaceId && projectId && <ProjectLinkedFiles client={client} workspaceId={workspaceId} projectId={projectId} folder={path} query={query} active={active} />}
          {!searching && pins.length > 0 && <section className="mb-3 border-b border-border/60 pb-3" aria-label={t("project_browser.pinned")}>
            <h3 className="flex items-center gap-2 px-2 py-2 text-xs font-medium text-muted-foreground"><Pin className="size-3.5" />{t("project_browser.pinned")}</h3>
            {pins.map(pin => renderEntry({ kind: "file", name: pin.name, path: pin.path }, true))}
          </section>}
          {searching ? <div>
            {query.trim() !== searchQuery || search.isFetching ? <p role="status" className="p-3 text-sm text-muted-foreground">{t("project_browser.searching")}</p> : search.error ? <PanelEmptyState icon={<AlertCircle />} title={t("project_browser.search_failed")} description={projectErrorMessage(search.error)}><Button variant="outline" size="sm" onClick={() => void search.refetch()}>{t("workspace_files.try_again")}</Button></PanelEmptyState> : <>
              {search.data?.items.filter(item => item.path).map(item => {
                const filePath = item.path!;
                const entry: LegalworkWorkspaceDirectoryEntry = { kind: "file", name: filePath.split("/").at(-1) || item.title, path: filePath, updatedAt: item.updatedAt };
                return <WorkspaceEntryMenu key={item.id} client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace}
                  folderPath={filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")))} entry={entry} onOpen={() => onOpenFile(entry)} onRefresh={() => void search.refetch()}>
                  <button className="flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" draggable onDragStart={event => { if (workspaceId) { writeWorkspaceFileDrag(event.dataTransfer, { workspaceId, path: filePath, name: entry.name }); if (client) projectFiles?.drag(event.dataTransfer, client, workspaceId, { path: filePath, name: entry.name }); } }} onClick={() => onOpenFile(entry)}>
                    <ArtifactIcon type={classifyOpenTarget(filePath, "file")} className="mt-0.5 size-5 shrink-0" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{filePath}</span>{item.excerpt && <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.excerpt}</span>}</span>
                  </button>
                </WorkspaceEntryMenu>;
              })}
              {!search.data?.items.length && <PanelEmptyState icon={<Search />} title={t("project_browser.no_matches")} description={t("project_browser.try_search")} />}
              {(search.data?.limited || search.data?.skipped || search.data?.preparing || search.data?.incomplete) ? <p role="status" className="p-3 text-xs text-muted-foreground">{t("project_browser.partial_search")}</p> : null}
            </>}
          </div> : isLoading ? (
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
              title={t("workspace_files.open_failed_title")}
              description={projectErrorMessage(error)}
            >
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                {t("workspace_files.try_again")}
              </Button>
            </PanelEmptyState>
          ) : visibleEntries.length === 0 ? (
            <PanelEmptyState icon={<FolderIcon open />} title={t("workspace_files.empty_title")} description={t("workspace_files.empty_body")}>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => setShowHidden(true)}
                >
                  {t("workspace_files.show_hidden_count", { count: hiddenCount })}
                </button>
              ) : null}
            </PanelEmptyState>
          ) : (
            <>
              {visibleEntries.map(entry => renderEntry(entry))}
              {data?.truncated ? (
                <p className="px-2.5 py-2 text-center text-[11px] text-muted-foreground/70">
                  {t("workspace_files.more_entries")}
                </p>
              ) : null}
              {!showHidden && hiddenCount > 0 ? (
                <button
                  type="button"
                  className="w-full rounded-md px-2.5 py-2 text-center text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                  onClick={() => setShowHidden(true)}
                >
                  {t("workspace_files.show_hidden_count", { count: hiddenCount })}
                </button>
              ) : null}
            </>
          )}
        </div>
        </WorkspaceEntryMenu>
      </div>
      </ProjectFilesDropzone>
      </ProjectFileDropTarget>
    </TooltipProvider>
  );
}
