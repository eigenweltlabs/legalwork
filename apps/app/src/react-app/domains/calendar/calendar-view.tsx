import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, FolderOpen, Link2, ListFilter, Loader2, MoreHorizontal, Plus, RefreshCw, Tags, Trash2, UserRound, X } from "lucide-react";
import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "@/components/filter-select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { SectionHeading } from "@/react-app/design-system/surface";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { TaskDialog } from "../tasks/task-dialog";
import { useTaskMembers } from "../tasks/tasks-queries";
import { taskMemberOptions } from "../tasks/task-format";
import { calendarAnchor, calendarDay, calendarError, calendarKindLabel, calendarRange, formatCalendarDay, isActive, isCompleted, moveCalendar, occurrenceDay, occursInRange, shiftDay, type CalendarViewMode } from "./calendar-format";
import { useCalendarOccurrences, useCalendarRecords, useCalendarRefresh, useConnectedCalendars, useConnectedCalendarEvents, type CalendarContext, type CalendarSource } from "./calendar-queries";
import { CalendarEntry } from "./calendar-entries";
import { CalendarGrid } from "./calendar-grid";
import { CalendarConflict, CalendarTrash } from "./calendar-management";
import { DeadlineDialog } from "./deadline-dialog";
import { CalendarSubscriptionDialog } from "./calendar-subscription-dialog";
import type { CalendarDisplayOccurrence } from "./connected-calendars";
import { ConnectedCalendarControls, ConnectedCalendarEventDialog } from "./connected-calendar-controls";
import { useCalendarVisibility } from "./calendar-visibility";

type CalendarViewProps = CalendarContext & {
  projectId?: string; projectName?: string; projects?: CalendarSource[];
  personalClient?: LegalworkServerClient | null;
};

export function CalendarView(props: CalendarViewProps) {
  const [search] = useSearchParams();
  const requestedDay = search.get('date');
  const [anchor, setAnchor] = useState(() => calendarAnchor(requestedDay) ?? new Date());
  useEffect(() => { const day = calendarAnchor(requestedDay); if (day) setAnchor(day); }, [requestedDay]);
  const [view, setView] = useState<CalendarViewMode>("week");
  const [kind, setKind] = useState("all"), [status, setStatus] = useState("active"), [project, setProject] = useState("all"), [assignee, setAssignee] = useState("all");
  const [trashOpen, setTrashOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [editing, setEditing] = useState<{ item: CalendarItem | null; day: string; client: LegalworkServerClient; workspaceId: string; projectId: string; projectName: string } | null>(null);
  const [task, setTask] = useState<{ id: string; client: LegalworkServerClient; workspaceId: string; projects: { id: string; name: string }[] } | null>(null);
  const [opening, setOpening] = useState(false);
  const [connectedEvent, setConnectedEvent] = useState<CalendarDisplayOccurrence | null>(null);
  const range = calendarRange(anchor, view);
  const loadedStart = shiftDay(range.start, view === "week" ? -7 : 0), loadedEnd = shiftDay(range.end, view === "week" ? 7 : 0);
  const loadedRange = { from: calendarDay(loadedStart), to: calendarDay(loadedEnd) };
  // Project records are expanded in their own zones. Include adjacent dates before
  // placing them on the viewer's common clock, then clip to the actual view.
  const query = useCalendarOccurrences(props, calendarDay(shiftDay(loadedStart, -2)), calendarDay(shiftDay(loadedEnd, 2))), records = useCalendarRecords(props), refresh = useCalendarRefresh();
  // Personal overlays always use this computer's client, including in remote projects.
  const personalClient = props.personalClient === undefined ? props.client : props.personalClient;
  const connected = useConnectedCalendars(personalClient);
  const visibility = useCalendarVisibility();
  const visibilityScope = props.projectId ?? props.workspaceId ?? "global";
  const hidden = visibility.hidden[visibilityScope] ?? [];
  const calendars = connected.data?.calendars ?? [];
  const visibleCalendars = calendars.filter(calendar => !hidden.includes(calendar.key));
  const eventQueries = useConnectedCalendarEvents(personalClient, visibleCalendars, loadedRange.from, loadedRange.to);
  const local = query.data?.occurrences ?? [];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all: CalendarDisplayOccurrence[] = [...new Map([...local, ...eventQueries.flatMap(result => result.data ?? [])].map(item => [item.id, item.allDay ? item : { ...item, timeZone }])).values()].filter(item => occursInRange(item, loadedRange.from, loadedRange.to)).sort((a, b) => a.start.localeCompare(b.start));
  const connectedUnavailable = [...new Set([...(connected.data?.unavailable ?? []), ...eventQueries.flatMap(result => result.isError ? [result.calendar.name] : [])])];
  const connectedLoading = connected.isFetching || eventQueries.some(result => result.isFetching);
  useEffect(() => {
    if (!connectedEvent?.connectedEvent) return;
    const key = connectedEvent.connectedEvent.calendar.key;
    const pages = eventQueries.filter(result => result.calendar.key === key && occursInRange(connectedEvent, result.from, result.to));
    if ((connected.isSuccess && !calendars.some(calendar => calendar.key === key)) ||
      (pages.length > 0 && pages.every(result => result.isSuccess && !result.isFetching) && !pages.some(result => result.data?.some(item => item.id === connectedEvent.id)))) setConnectedEvent(null);
  }, [connectedEvent, connected.isSuccess, calendars, eventQueries]);
  const membersWorkspaceId = props.workspaceId ?? local.find(item => item.projectId && !props.remoteSources?.some(source => source.id === item.projectId))?.projectId ?? "";
  const members = useTaskMembers({ client: props.client, workspaceId: membersWorkspaceId });
  const projects = [...new Map(local.map(item => [item.projectId ?? "inbox", item.projectName])).entries()];
  const items = all.filter(item => (kind === "all" || kind === item.kind) && (item.connectedEvent || project === "all" || project === (item.projectId ?? "inbox")) &&
    (item.connectedEvent || assignee === "all" || assignee === (item.assigneeUserId ?? "unassigned")) && (status === "all" || (status === "active" ? isActive(item) : status === "completed" ? isCompleted(item) : item.status === "cancelled")));
  const filtered = kind !== "all" || status !== "active" || project !== "all" || assignee !== "all";
  const create = (day = calendarDay(new Date())) => {
    const target = props.workspaceId && props.client ? { client: props.client, workspaceId: props.workspaceId, projectId: props.projectId ?? props.workspaceId, projectName: props.projectName ?? "" }
      : (() => { const source = props.projects?.find(value => value.id === project) ?? props.projects?.[0]; return source ? { ...source, projectId: source.id, projectName: source.name } : null; })();
    if (target) setEditing({ ...target, item: null, day });
  };
  const canCreate = Boolean(props.workspaceId || props.projects?.length);
  const open = async (item: CalendarDisplayOccurrence) => {
    if (item.connectedEvent) { setConnectedEvent(item); return; }
    const source = props.workspaceId ? undefined : props.remoteSources?.find(source => source.id === item.projectId);
    const client = source?.client ?? props.client, workspaceId = source?.workspaceId ?? props.workspaceId ?? item.projectId;
    if (item.kind === "task") {
      // Inbox tasks use a local workspace for transport; remote tasks keep their source endpoint.
      const taskWorkspaceId = workspaceId ?? props.projects?.find(project => !props.remoteSources?.some(remote => remote.id === project.id))?.workspaceId;
      if (client && taskWorkspaceId) setTask({ id: item.itemId, client, workspaceId: taskWorkspaceId,
        projects: props.workspaceId ? [{ id: props.workspaceId, name: props.projectName ?? item.projectName }]
          : (props.projects ?? []).filter(project => project.client.baseUrl === client.baseUrl).map(project => ({ id: project.workspaceId, name: project.name })),
      });
      return;
    }
    if (!client || !workspaceId || opening) return;
    setOpening(true);
    try { setEditing({ item: (await client.calendarItem(workspaceId, item.itemId)).item, day: occurrenceDay(item), client, workspaceId, projectId: props.projectId ?? source?.id ?? workspaceId, projectName: item.projectName }); }
    catch (error) { toast.error(calendarError(error)); } finally { setOpening(false); }
  };
  const title = view === "week"
    ? new Intl.DateTimeFormat(currentLocale(), { month: "short", day: "numeric", year: "numeric" }).formatRange(range.start, shiftDay(range.end, -1))
    : anchor.toLocaleDateString(currentLocale(), view === "day" ? { weekday: "short", day: "numeric", month: "long", year: "numeric" } : { month: "long", year: "numeric" });
  const showDay = (day: Date) => { setAnchor(day); setView("day"); };
  const secondaryKinds: CalendarOccurrence["kind"][] = ["journal", "freebusy"];
  const kindOptions = [{ value: "all", label: t("calendar.all_types") }, { value: "deadline", label: t("calendar.deadline") }, { value: "task", label: t("calendar.task") }, { value: "event", label: t("calendar.event") },
    ...secondaryKinds.filter(value => all.some(item => item.kind === value)).map(value => ({ value, label: calendarKindLabel(value) }))];
  const projectOptions = [{ value: "all", label: t("calendar.all_projects_short") }, ...projects.map(([value, label]) => ({ value, label }))];
  if (project !== "all" && !projectOptions.some(option => option.value === project)) projectOptions.push({ value: project, label: t("calendar.selected_project") });

  return <div className="@container/calendar flex h-full min-h-0 flex-col bg-background">
    <div className="flex h-full min-h-0 flex-col gap-4 px-4 py-5 @min-[720px]/calendar:px-6">
      <SectionHeading size="page" className="shrink-0 [&_h1]:text-xl" title={t("calendar.title")} description={!props.workspaceId ? t("calendar.all_projects_short") : undefined} action={<>
        <Button variant="outline" disabled={!props.client} onClick={() => setSubscriptionOpen(true)}><Link2 />{t("calendar.subscribe")}</Button>
        {canCreate && <Button disabled={!props.client} onClick={() => create()}><Plus />{t("calendar.add")}</Button>}
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("common.refresh")} disabled={query.isFetching || connectedLoading} onClick={refresh} />}><RefreshCw className={cn((query.isFetching || connectedLoading) && "animate-spin")} /></TooltipTrigger><TooltipContent>{t("common.refresh")}</TooltipContent></Tooltip>
        {props.workspaceId && <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("calendar.more_actions")} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={records.isPending || records.isError} onClick={() => setTrashOpen(true)}><Trash2 />{t("calendar.trash")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      </>} />
      <Tabs value={view} onValueChange={value => { if (value === "day" || value === "week" || value === "month" || value === "agenda") setView(value); }} className="min-h-0 flex-1 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t(view === "day" ? "calendar.previous_day" : view === "week" ? "calendar.previous_week" : "calendar.previous")} onClick={() => setAnchor(moveCalendar(anchor, view, -1))}><ChevronLeft /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t(view === "day" ? "calendar.next_day" : view === "week" ? "calendar.next_week" : "calendar.next")} onClick={() => setAnchor(moveCalendar(anchor, view, 1))}><ChevronRight /></Button>
            <h2 className="mx-2 text-sm font-medium" aria-live="polite">{title}</h2>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setAnchor(new Date())}>{t("calendar.today")}</Button>
          </div>
          <TabsList aria-label={t("calendar.view")} className="h-8!">
            <TabsTrigger className="px-2.5 text-xs" value="day">{t("calendar.day_view")}</TabsTrigger>
            <TabsTrigger className="px-2.5 text-xs" value="week">{t("calendar.week")}</TabsTrigger>
            <TabsTrigger className="px-2.5 text-xs" value="month">{t("calendar.month")}</TabsTrigger>
            <TabsTrigger className="px-2.5 text-xs" value="agenda">{t("calendar.agenda")}</TabsTrigger>
          </TabsList>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pb-1">
          <FilterSelect icon={Tags} label={t("calendar.type")} value={kind} active={kind !== "all"} onChange={setKind} options={kindOptions} />
          <FilterSelect icon={ListFilter} label={t("calendar.status")} value={status} active={status !== "active"} onChange={setStatus} options={[{ value: "active", label: t("calendar.active") }, { value: "completed", label: t("calendar.completed") }, { value: "all", label: t("calendar.all_statuses") }]} />
          {!props.workspaceId && <FilterSelect icon={FolderOpen} label={t("calendar.project")} value={project} active={project !== "all"} onChange={setProject} options={projectOptions} />}
          {Boolean(members.data?.length) && <FilterSelect icon={UserRound} label={t("calendar.assignee")} value={assignee} active={assignee !== "all"} onChange={setAssignee} options={[{ value: "all", label: t("calendar.all_assignees") }, { value: "unassigned", label: t("calendar.unassigned") }, ...taskMemberOptions(members.data ?? [])]} />}
          {filtered && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => { setKind("all"); setStatus("active"); setProject("all"); setAssignee("all"); }}><X className="size-3" />{t("calendar.clear_filters")}</Button>}
          <ConnectedCalendarControls calendars={calendars} hidden={hidden} loading={connectedLoading} disabled={!personalClient} onVisible={(key, visible) => visibility.setVisible(visibilityScope, key, visible)} />
          {opening && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" aria-label={t("calendar.loading")} />}
        </div>
        {props.client && props.workspaceId && records.data?.conflicts.map(remote => {
          const current = records.data.items.find(item => item.id === remote.id);
          return current ? <CalendarConflict key={remote.id} current={current} remote={remote} client={props.client!} workspaceId={props.workspaceId!} onChanged={refresh} /> : null;
        })}
        {query.data?.unavailable.length ? <p role="status" className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">{t("calendar.unavailable_projects", { projects: query.data.unavailable.join(", ") })}</p> : null}
        {connected.isError || connectedUnavailable.length > 0 ? <p role="alert" className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">{t("calendar.connected_unavailable", { calendars: connectedUnavailable.join(", ") || t("calendar.connected_calendars") })}</p> : null}
        {query.isError || records.isError ? <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 p-4 text-sm"><span>{calendarError(query.error ?? records.error)}</span><Button size="sm" variant="outline" onClick={refresh}>{t("workspace_files.try_again")}</Button></div> : null}
        <>
          {query.isPending && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{t("calendar.loading")}</p>}
          {(["day", "week", "month"] satisfies ("day" | "week" | "month")[]).map(mode => <TabsContent key={mode} value={mode} className="min-h-0 overflow-hidden"><CalendarGrid view={mode} anchor={anchor} start={range.start} items={items} projectId={props.projectId ?? props.workspaceId} showProjects={!props.workspaceId} timeZone={timeZone} onDay={showDay} onWeekChange={direction => setAnchor(current => moveCalendar(current, "week", direction))} onOpen={item => void open(item)} onCreate={canCreate ? create : undefined} /></TabsContent>)}
          <TabsContent value="agenda" className="min-h-0 overflow-y-auto"><CalendarAgenda from={range.from} items={items} projectId={props.projectId ?? props.workspaceId} showProjects={!props.workspaceId} onOpen={item => void open(item)} /></TabsContent>
        </>
      </Tabs>
      {trashOpen && props.client && props.workspaceId && <CalendarTrash client={props.client} workspaceId={props.workspaceId} items={records.data?.items.filter(item => item.deletedAt) ?? []} onClose={() => setTrashOpen(false)} onChanged={refresh} />}
      {subscriptionOpen && props.client && <CalendarSubscriptionDialog client={props.client} workspaceId={props.workspaceId ?? null} projectName={props.projectName} hasRemoteProjects={!props.workspaceId && Boolean(props.remoteSources?.length)} onClose={() => setSubscriptionOpen(false)} />}
      {task && <TaskDialog taskId={task.id} client={task.client} workspaceId={task.workspaceId} projects={task.projects} onClose={() => setTask(null)} />}
      {connectedEvent && <ConnectedCalendarEventDialog item={all.find(item => item.id === connectedEvent.id) ?? connectedEvent} onClose={() => setConnectedEvent(null)} />}
      {editing && <DeadlineDialog key={editing.item?.id ?? editing.day} client={editing.client} workspaceId={editing.workspaceId} projectId={editing.projectId} projectName={editing.projectName} projects={props.projects} item={editing.item} day={editing.day} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </div>
  </div>;
}

function CalendarAgenda({ from, items, projectId, showProjects, onOpen }: { from: string; items: CalendarDisplayOccurrence[]; projectId?: string; showProjects: boolean; onOpen: (item: CalendarDisplayOccurrence) => void }) {
  const visibleDay = (item: CalendarOccurrence) => occurrenceDay(item) < from ? from : occurrenceDay(item);
  const days = [...new Set(items.map(visibleDay))].sort();
  if (!days.length) return <Empty className="min-h-64"><EmptyHeader><EmptyMedia variant="icon"><CalendarDays /></EmptyMedia><EmptyTitle>{t("calendar.empty_title")}</EmptyTitle><EmptyDescription>{t("calendar.empty")}</EmptyDescription></EmptyHeader></Empty>;
  return <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">{days.map(day => <section key={day} className="grid gap-3 p-4 @min-[640px]/calendar:grid-cols-[140px_1fr]">
    <h3 className="pt-2 text-xs font-medium"><time dateTime={day}>{formatCalendarDay(day, { weekday: "short", day: "numeric", month: "short" })}</time></h3>
    <div className="min-w-0 space-y-1.5">{items.filter(item => visibleDay(item) === day).map(item => <CalendarEntry key={item.id} item={item} projectId={projectId} showProject={showProjects} onOpen={() => onOpen(item)} />)}</div>
  </section>)}</div>;
}
