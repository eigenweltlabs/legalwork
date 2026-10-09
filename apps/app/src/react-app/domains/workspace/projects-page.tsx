import { useId, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, FolderOpen, MessageSquare, MoreHorizontal, PanelsTopLeft, Pencil, PenLine, Pin, PinOff, Plus, Search, Trash2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { WorkspaceSessionGroup } from "@/app/types";
import { formatRelativeTime, isMacPlatform } from "@/app/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ProjectFolderIcon } from "./project-sync";
import { useProjectSyncStore } from "./project-sync-store";
import { SectionHeading } from "../../design-system/surface";
import { allProjectSessions, SessionProjectHover } from "../session/sidebar/session-project-hover";
import { workspaceLabel } from "../session/sidebar/utils";
import { useProjectFavoritesStore } from "./project-favorites-store";
import { useShellConfig, type ProjectNavKey } from "../../shell/shell-config";
import { SIDEBAR_ITEMS } from "../session/sidebar/sidebar-customization";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { defaultAkteFields, useProjectDefaultsStore, withInitialProjectFields } from "./project-defaults-store";
import { collectProjectFilterFields, matchesProjectFilters, useProjectFilterStore } from "./project-filters";
import { ProjectFilterBar } from "./project-filter-bar";
import { ProjectViews } from "./project-views";
import { useProjectPersonalisation } from "./project-personalisation-modal";

type ProjectPage = Exclude<ProjectNavKey, "projectSessions">;
type Props = {
  client: LegalworkServerClient | null;
  groups: WorkspaceSessionGroup[];
  onOpenProject: (id: string, page: ProjectPage | "workspace") => void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onNewChat: (workspaceId: string) => void;
  onCreate: () => void;
  onOpenSearch?: () => void;
  onRename: (id: string) => void;
  onReveal: (id: string) => void;
  onForget: (id: string) => void;
  newChatDisabled: boolean;
};
const PAGE_SIZE = 10;
// One grid aligns project names, session names, timestamps and actions, even with a side panel open.
const rowGrid = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 @min-[620px]/project-page:grid-cols-[minmax(0,1fr)_5.5rem_10.5rem]";

function Updated({ timestamp }: { timestamp: number }) {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  const label = !timestamp ? "—" : days >= 1 && days < 30 ? t("projects.days_ago", { count: days }) : formatRelativeTime(timestamp);
  return <time className="hidden truncate text-right text-xs tabular-nums text-muted-foreground @min-[620px]/project-page:block" dateTime={timestamp ? new Date(timestamp).toISOString() : undefined} title={timestamp ? new Date(timestamp).toLocaleString() : undefined}>{label}</time>;
}

export function ProjectsPage(props: Props) {
  const [page, setPage] = useState(0);
  const favoriteIds = useProjectFavoritesStore(state => state.favoriteIds);
  const filterState = useProjectFilterStore();
  const syncStates = useProjectSyncStore(state => state.states);
  const filtered = filterState.teamOnly || filterState.filters.length > 0;
  const { descending, setDescending } = filterState;
  const savedDefaults = useProjectDefaultsStore(state => state.fields);
  const defaults = savedDefaults ?? defaultAkteFields();
  const endpoints = useMemo(() => props.groups.map(({ workspace }) => resolveWorkspaceEndpoint(workspace, { baseUrl: props.client?.baseUrl, token: props.client?.token })), [props.groups, props.client]);
  // Use the same project cache as Home; values edited there update filters too.
  // Read metadata for every project, not just the current page.
  const details = useQueries({ queries: endpoints.map((endpoint, index) => ({
    queryKey: ["project", endpoint?.workspaceId ?? props.groups[index].workspace.id],
    queryFn: () => {
      if (!endpoint) throw new Error("Project connection unavailable");
      return endpoint.client.getProjectDetails(endpoint.workspaceId);
    },
    enabled: Boolean(endpoint),
    staleTime: 30_000,
    retry: 1,
  })) });
  const projectFields = details.map(result => result.data ? withInitialProjectFields(result.data, defaults).fields : null);
  const fields = collectProjectFilterFields([defaults, ...projectFields.filter(fields => fields !== null)]);
  const inTeamScope = (index: number) => !filterState.teamOnly || syncStates[props.groups[index].workspace.id] !== undefined;
  const metadataLoading = filterState.filters.length > 0 && details.some((result, index) => inTeamScope(index) && endpoints[index] && !result.data && result.isPending);
  const unavailable = details.filter((result, index) => inTeamScope(index) && !result.data && (result.isError || !endpoints[index])).length;
  const sortedGroups = useMemo(() => props.groups
    .map(group => ({ group, updated: Math.max(0, ...group.sessions.map(session => session.time?.updated ?? session.time?.created ?? 0)) }))
    .sort((a, b) => Number(favoriteIds.includes(b.group.workspace.id)) - Number(favoriteIds.includes(a.group.workspace.id)) || (descending ? b.updated - a.updated : a.updated - b.updated)), [props.groups, descending, favoriteIds]);
  const fieldsByProject = new Map(props.groups.map((group, index) => [group.workspace.id, projectFields[index]]));
  const groups = sortedGroups.filter(({ group }) => {
    if (filterState.teamOnly && syncStates[group.workspace.id] === undefined) return false;
    if (!filterState.filters.length) return true;
    const fields = fieldsByProject.get(group.workspace.id);
    return fields !== null && fields !== undefined && matchesProjectFilters(fields, filterState.filters, filterState.mode);
  });
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return <div className="@container/project-page h-full overflow-auto bg-background">
    <div className="lw-page-content lw-page-top pb-8">
      <SectionHeading size="page" title={t("projects.plural")} className="mb-6" action={<>
          <Tooltip><TooltipTrigger render={<Button variant="outline" className="w-52 max-w-full justify-start gap-2 font-normal text-muted-foreground" aria-haspopup="dialog" aria-keyshortcuts={isMacPlatform() ? "Meta+k" : "Control+k"} onClick={props.onOpenSearch} />}><Search className="size-4" />{t("content_search.title")}<kbd className="ml-auto font-sans text-xs">{isMacPlatform() ? "⌘ K" : "Ctrl K"}</kbd></TooltipTrigger><TooltipContent>{t("content_search.open_shortcut", { shortcut: isMacPlatform() ? "⌘ K" : "Ctrl + K" })}</TooltipContent></Tooltip>
          <Button onClick={props.onCreate}><Plus className="size-4" />{t("projects.create")}</Button>
      </>} />
      <ProjectViews onSelect={() => setPage(0)} />
      <ProjectFilterBar fields={fields} filters={filterState.filters} mode={filterState.mode}
        teamOnly={filterState.teamOnly} onTeamOnlyChange={teamOnly => { filterState.setTeamOnly(teamOnly); setPage(0); }}
        onChange={filters => { filterState.setFilters(filters); setPage(0); }}
        onModeChange={mode => { filterState.setMode(mode); setPage(0); }}
        onClear={() => { filterState.clear(); setPage(0); }} resultCount={groups.length} totalCount={props.groups.length}
        loading={metadataLoading} unavailable={unavailable} onRetry={() => { details.forEach(result => { if (result.isError) void result.refetch(); }); }} />
      <div className={cn(rowGrid, "border-b border-border/70 px-2 pb-2 text-xs text-muted-foreground")}>
        <span className="pl-6">{t("sidebar.project_name")}</span>
        <Button variant="ghost" size="xs" className="hidden justify-self-end px-0 hover:bg-transparent @min-[620px]/project-page:inline-flex" onClick={() => { setDescending(!descending); setPage(0); }}>{t("sidebar.updated")}{descending ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}</Button>
        <span aria-hidden />
      </div>
      {groups.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(({ group, updated }) => <ProjectRow key={group.workspace.id} {...props} group={group} updated={updated} />)}
      {!groups.length && <div className="flex flex-col items-center gap-2 py-14 text-center text-sm text-muted-foreground" role="status">
        <p>{t(filtered ? metadataLoading ? "project_filters.loading" : "project_filters.no_matches" : "sidebar.no_projects")}</p>
        {filtered && !metadataLoading && <Button variant="outline" size="sm" onClick={() => { filterState.clear(); setPage(0); }}>{t("project_filters.clear")}</Button>}
      </div>}
      {pages > 1 && <Pagination current={current} pages={pages} onChange={setPage} />}
    </div>
  </div>;
}

function Pagination({ current, pages, onChange }: { current: number; pages: number; onChange: (page: number) => void }) {
  return <div className="flex items-center justify-end gap-2 py-2 text-xs tabular-nums text-muted-foreground">
    <Button variant="ghost" size="icon-sm" aria-label={t("sidebar.previous_page")} disabled={current === 0} onClick={() => onChange(current - 1)}><ChevronLeft className="size-4" /></Button>
    <span>{current + 1} / {pages}</span>
    <Button variant="ghost" size="icon-sm" aria-label={t("sidebar.next_page")} disabled={current + 1 >= pages} onClick={() => onChange(current + 1)}><ChevronRight className="size-4" /></Button>
  </div>;
}

function ProjectRow({ group, updated, ...props }: Props & { group: WorkspaceSessionGroup; updated: number }) {
  const openPersonalisation = useProjectPersonalisation();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { config } = useShellConfig();
  const [page, setPage] = useState(0);
  const favorites = useProjectFavoritesStore();
  const id = group.workspace.id;
  const name = workspaceLabel(group.workspace);
  const pinned = favorites.favoriteIds.includes(id);
  const sessions = allProjectSessions([group]);
  const pages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const projectPages = config.projectNavOrder.filter((key): key is ProjectPage => key !== "projectSessions" && config[key]);
  return <section className="border-b border-border/70 py-1.5">
    <div className={cn(rowGrid, "relative min-h-12 rounded-lg px-2")}>
      <button type="button" className="absolute inset-0 cursor-pointer rounded-lg transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={name} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)} />
      <div className="pointer-events-none relative flex min-w-0 items-center gap-2.5">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <ProjectFolderIcon workspaceId={id} open={expanded} />
        <span className="truncate text-sm font-medium">{name}</span>
        {pinned && <Pin className="size-3 shrink-0 fill-current text-muted-foreground" />}
        {sessions.length > 0 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70" title={t("projects.sessions")}>{sessions.length}</span>}
      </div>
      <span className="pointer-events-none relative hidden @min-[620px]/project-page:block"><Updated timestamp={updated} /></span>
      <div className="pointer-events-none relative flex items-center justify-end gap-0.5 [&>button]:pointer-events-auto">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" aria-label={t("projects.open_project")}><span>{t("projects.open")}</span><ChevronDown className="size-3" /></Button>} />
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={() => props.onOpenProject(id, "workspace")}><PanelsTopLeft className="size-4" />{t("workspace.workbench")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            {projectPages.map(key => {
              const { icon: Icon, label } = SIDEBAR_ITEMS[key];
              return <DropdownMenuItem key={key} onClick={() => props.onOpenProject(id, key)}><Icon className="size-4" />{t(label)}</DropdownMenuItem>;
            })}
            {!projectPages.length && <DropdownMenuItem onClick={() => props.onOpenProject(id, "projectHome")}><ArrowUpRight className="size-4" />{t("projects.open_project")}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("projects.new_chat")} title={t("projects.new_chat")} disabled={props.newChatDisabled} onClick={() => props.onNewChat(id)}><PenLine className="size-3.5" /></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("sidebar.project_actions")}><MoreHorizontal className="size-4" /></Button>} /><DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => favorites.toggleFavorite(id)}>{pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}{t(pinned ? "sidebar.unpin_project" : "sidebar.pin_project")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => props.onRename(id)}><Pencil className="size-4" />{t("sidebar.rename_project")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPersonalisation(id)}><WandSparkles className="size-4" />{t("personalisation.project_prompt_menu")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => props.onReveal(id)}><FolderOpen className="size-4" />{t("sidebar.reveal_project")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => props.onForget(id)}><Trash2 className="size-4" />{t("sidebar.remove_project")}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
    </div>
    <div id={contentId} hidden={!expanded} className="relative pb-1 pt-0.5">
      {expanded && <>
        <span aria-hidden className="pointer-events-none absolute bottom-2 left-[2.625rem] top-1 w-px bg-border/75" />
        <nav aria-label={name} className="mb-2 ml-12 mr-2 flex flex-wrap items-center gap-1 pt-1">
          <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-xs font-normal" onClick={() => props.onOpenProject(id, "workspace")}><PanelsTopLeft className="size-3.5" />{t("workspace.workbench")}</Button>
          {projectPages.map(key => {
            const { icon: Icon, label } = SIDEBAR_ITEMS[key];
            return <Button key={key} variant="ghost" size="sm" className="gap-1.5 px-2 text-xs font-normal" onClick={() => props.onOpenProject(id, key)}><Icon className="size-3.5" />{t(label)}</Button>;
          })}
        </nav>
        <div className="space-y-0.5">
          {sessions.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(({ session }) => <SessionProjectHover key={session.id} session={session} projectName={name}>
            <button type="button" className={cn(rowGrid, "group min-h-9 w-full cursor-pointer rounded-lg px-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")} onClick={() => props.onOpenSession(id, session.id)}>
              <span className="flex min-w-0 items-center gap-2.5 pl-12"><MessageSquare className="size-3.5 shrink-0 text-muted-foreground/65" /><span className="truncate text-[13px]">{getDisplaySessionTitle(session.title)}</span></span>
              <Updated timestamp={session.time?.updated ?? session.time?.created ?? 0} />
              <span className="flex justify-end" aria-hidden><ArrowUpRight className="mr-2 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /></span>
            </button>
          </SessionProjectHover>)}
        </div>
        {!sessions.length && <p className="py-3 pl-14 text-xs text-muted-foreground">{t(group.status === "loading" ? "workspace.loading_tasks" : group.status === "error" ? "sidebar.sessions_unavailable" : "projects.no_sessions")}</p>}
        {pages > 1 && <Pagination current={current} pages={pages} onChange={setPage} />}
      </>}
    </div>
  </section>;
}
