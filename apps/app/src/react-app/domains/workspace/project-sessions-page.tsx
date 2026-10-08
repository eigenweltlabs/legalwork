import { ProjectFileDropTarget } from "./project-file-transfer";
import { useMemo, useRef, useState } from "react";
import { Archive, ArrowUpRight, ChevronDown, GitBranch, MessageSquare, MoreHorizontal, Pencil, Pin, Plus, Search, Trash2, X } from "lucide-react";
import { matchesSearch } from "@legalwork/types/search";
import type { WorkspaceSessionGroup } from "@/app/types";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/sonner";
import { useListSelection } from "./use-list-selection";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import { isSessionArchived, isStreamingSessionStatus } from "../session/sidebar/utils";
import { startSessionsDrag } from "../session/sidebar/session-drag";
import { useSessionManagementStore } from "../session/sidebar/session-management-store";

type SessionFilter = "recent" | "pinned" | "archived";

export function ProjectSessionsPage(props: {
  workspaceId: string;
  group?: WorkspaceSessionGroup;
  statuses?: Record<string, string>;
  onOpen: (id: string) => void;
  onNew: () => void;
  newDisabled: boolean;
  onRename?: (id: string) => void;
  onArchive?: (id: string, archived: boolean) => void | Promise<void>;
  onDelete?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("recent");
  const [newestFirst, setNewestFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const pinnedIds = useSessionManagementStore(state => state.pinnedIds);
  const togglePin = useSessionManagementStore(state => state.togglePin);
  const groups = useSessionManagementStore(state => state.groupsByWorkspace[props.workspaceId]);
  const sessions = useMemo(() => (props.group?.sessions ?? []).filter(session =>
    (filter === "archived" ? isSessionArchived(session) : !isSessionArchived(session)) &&
    (filter !== "pinned" || pinnedIds.includes(session.id)) && matchesSearch(getDisplaySessionTitle(session.title), query),
  ).sort((a, b) => ((b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0)) * (newestFirst ? 1 : -1)), [props.group?.sessions, filter, pinnedIds, query, newestFirst]);
  const loaded = props.group?.status === "ready" || Boolean(props.group?.sessions.length);
  const selection = useListSelection(sessions.map(session => session.id), `${props.workspaceId}:${filter}`);
  const allPinned = selection.ids.length > 0 && selection.ids.every(id => pinnedIds.includes(id));
  const archiveSelected = async () => {
    if (!props.onArchive || working.current) return;
    working.current = true; setBusy(true);
    try { for (const id of selection.ids) await props.onArchive(id, filter !== "archived"); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("storage.failed")); }
    finally { working.current = false; setBusy(false); }
  };
  return <section className="@container/sessions h-full min-h-0 overflow-auto" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) selection.clear(); }}>
    <div className="lw-project-page-content lw-project-page-top pb-8">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-5">
        <div><h1 className="text-2xl font-semibold tracking-tight">{t("projects.sessions")}</h1><p className="mt-1.5 text-sm text-muted-foreground">{t("project_browser.sessions_description")}</p></div>
        <ProjectFileDropTarget projectId={props.workspaceId} mode="chat"><Button disabled={props.newDisabled} onClick={props.onNew}><Plus className="size-4" />{t("project_browser.new_session")}</Button></ProjectFileDropTarget>
      </header>
      <div className="flex flex-wrap items-center gap-3 pb-4">
        <div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9 pr-9" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("project_browser.search_sessions")} aria-label={t("project_browser.search_sessions")} />{query && <Button variant="ghost" size="icon-xs" className="absolute right-1.5 top-1/2 -translate-y-1/2" aria-label={t("legalmemory.clear_search")} onClick={() => setQuery("")}><X className="size-3.5" /></Button>}</div>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="sm"><span>{t(newestFirst ? "project_browser.newest" : "project_browser.oldest")}</span><ChevronDown className="size-3.5" /></Button>} /><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setNewestFirst(true)}>{t("project_browser.newest")}</DropdownMenuItem><DropdownMenuItem onClick={() => setNewestFirst(false)}>{t("project_browser.oldest")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1 rounded-lg bg-muted/40 p-1" role="group" aria-label={t("project_browser.filter_sessions")}>{(["recent", "pinned", "archived"] satisfies SessionFilter[]).map(value => <Button key={value} variant="choice" size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "pinned" ? <Pin className="size-3.5" /> : value === "archived" ? <Archive className="size-3.5" /> : null}{t(value === "recent" ? "project_browser.recent" : value === "pinned" ? "project_browser.pinned" : "project_browser.archived")}</Button>)}<span className="ml-auto px-2 text-xs tabular-nums text-muted-foreground">{sessions.length}</span></div>
      {props.group?.error && <p role="alert" className="mb-4 text-sm text-destructive">{props.group.error}</p>}
      {!!sessions.length && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 px-4 py-2" role="group" aria-label={t("project_browser.selection_actions")}>
        <Checkbox aria-label={t("project_browser.select_visible_sessions")} disabled={busy} checked={selection.ids.length === sessions.length} indeterminate={selection.ids.length > 0 && selection.ids.length < sessions.length} onCheckedChange={checked => checked ? selection.all() : selection.clear()} />
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{selection.ids.length ? t("project_browser.selected_count", { count: selection.ids.length }) : t("project_browser.select_sessions")}</span>
        {!!selection.ids.length && <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { selection.ids.forEach(props.onOpen); selection.clear(); }}>{t("project_browser.open_selected")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => selection.ids.forEach(id => { if (pinnedIds.includes(id) === allPinned) togglePin(id); })}><Pin className="size-3.5" />{t(allPinned ? "project_browser.unpin_selected" : "project_browser.pin_selected")}</Button>
          {props.onArchive && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void archiveSelected()}><Archive className="size-3.5" />{t(filter === "archived" ? "project_browser.restore_selected" : "project_browser.archive_selected")}</Button>}
          <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={t("project_browser.clear_selection")} onClick={selection.clear}><X className="size-4" /></Button>
        </>}
      </div>}
      {!loaded && props.group?.status !== "error" ? <div className="space-y-3">{[1, 2, 3].map(id => <Skeleton key={id} className="h-16 w-full rounded-xl" />)}</div> : !sessions.length ? <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center"><MessageSquare className="mb-3 size-7 text-muted-foreground" strokeWidth={1.4} /><h2 className="font-medium">{t(query ? "project_browser.no_matches" : "project_browser.no_sessions")}</h2><p className="mt-2 max-w-sm text-sm text-muted-foreground">{t(query ? "project_browser.try_search" : filter === "pinned" ? "project_browser.pin_hint" : filter === "archived" ? "project_browser.archive_hint" : "project_browser.new_hint")}</p></div> : <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {sessions.map(session => {
          const title = getDisplaySessionTitle(session.title);
          const pinned = pinnedIds.includes(session.id);
          const archived = isSessionArchived(session);
          const running = isStreamingSessionStatus(props.statuses?.[session.id]);
          const group = groups?.groups.find(group => group.id === groups.assignments[session.id]);
          const updated = session.time?.updated ?? session.time?.created;
          const selected = selection.ids.includes(session.id);
          return <li key={session.id} draggable={!busy} onDragStart={event => startSessionsDrag(event.dataTransfer, props.workspaceId, selected ? selection.ids : [session.id])} className={cn("group flex min-w-0 items-center gap-1 px-2 py-1.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/35", selected && "bg-primary/10")}>
            <Checkbox className="ml-2" disabled={busy} aria-label={t("project_browser.select_item", { name: title })} checked={selected} onCheckedChange={(_checked, details) => selection.toggle(session.id, details.event instanceof MouseEvent && details.event.shiftKey)} />
            <button draggable={!busy} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || selection.ids.length) selection.toggle(session.id, event.shiftKey); else props.onOpen(session.id); }}>
              {session.parentID ? <GitBranch className="size-4 shrink-0 text-muted-foreground" /> : <MessageSquare className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{title}</span><span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{updated ? <time dateTime={new Date(updated).toISOString()}>{new Date(updated).toLocaleDateString(currentLocale(), { month: "short", day: "numeric", year: "numeric" })}</time> : null}{group && <span>{group.label}</span>}{session.parentID && <span>{t("project_browser.branch")}</span>}{running && <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />{t("project_browser.running")}</span>}</span></span>
              <ArrowUpRight className="hidden size-4 shrink-0 text-muted-foreground @min-[600px]/sessions:block" />
            </button>
            <Button variant="ghost" size="icon-sm" className={cn("shrink-0 text-muted-foreground", !pinned && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100")} aria-label={t(pinned ? "project_browser.unpin" : "project_browser.pin", { name: title })} aria-pressed={pinned} onClick={() => togglePin(session.id)}><Pin className={cn("size-3.5", pinned && "fill-current")} /></Button>
            {(props.onRename || props.onArchive || props.onDelete) && <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("project_browser.session_actions", { name: title })}><MoreHorizontal className="size-4" /></Button>} /><DropdownMenuContent align="end">{props.onRename && <DropdownMenuItem onClick={() => props.onRename?.(session.id)}><Pencil />{t("session.rename_title")}</DropdownMenuItem>}{props.onArchive && <DropdownMenuItem onClick={() => props.onArchive?.(session.id, !archived)}><Archive />{t(archived ? "project_browser.unarchive" : "project_browser.archive")}</DropdownMenuItem>}{props.onDelete && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => props.onDelete?.(session.id)}><Trash2 />{t("project_browser.delete_session")}</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>}
          </li>;
        })}
      </ul>}
    </div>
  </section>;
}
