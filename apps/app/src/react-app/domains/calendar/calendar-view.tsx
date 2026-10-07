import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, FolderOpen, Link2, ListFilter, Loader2, MoreHorizontal, MoveHorizontal, Plus, RefreshCw, Tags, Trash2, UserRound, X } from "lucide-react";
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
import { calendarDay, calendarError, calendarKindLabel, calendarRange, formatCalendarDay, isActive, isCompleted, moveCalendar, occurrenceDay, occursOnDay, shiftDay, type CalendarViewMode } from "./calendar-format";
import { useCalendarOccurrences, useCalendarRecords, useCalendarRefresh, type CalendarContext, type CalendarSource } from "./calendar-queries";
import { CalendarEntry } from "./calendar-entries";
import { CalendarConflict, CalendarTrash } from "./calendar-management";
import { DeadlineDialog } from "./deadline-dialog";
import { CalendarSubscriptionDialog } from "./calendar-subscription-dialog";

type CalendarViewProps = CalendarContext & {
  projectId?: string; projectName?: string; projects?: CalendarSource[];
};

export function CalendarView(props: CalendarViewProps) {
  const [anchor, setAnchor] = useState(() => new Date());
  const [view, setView] = useState<CalendarViewMode>("week");
  const [kind, setKind] = useState("all"), [status, setStatus] = useState("active"), [project, setProject] = useState("all"), [assignee, setAssignee] = useState("all");
  const [trashOpen, setTrashOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [editing, setEditing] = useState<{ item: CalendarItem | null; day: string; client: LegalworkServerClient; workspaceId: string; projectId: string; projectName: string } | null>(null);
  const [task, setTask] = useState<{ id: string; client: LegalworkServerClient; workspaceId: string; projects: { id: string; name: string }[] } | null>(null);
  const [opening, setOpening] = useState(false);
  const range = calendarRange(anchor, view);
  const query = useCalendarOccurrences(props, range.from, range.to), records = useCalendarRecords(props), refresh = useCalendarRefresh();
  const all = query.data?.occurrences ?? [];
  const membersWorkspaceId = props.workspaceId ?? all.find(item => item.projectId && !props.remoteSources?.some(source => source.id === item.projectId))?.projectId ?? "";
  const members = useTaskMembers({ client: props.client, workspaceId: membersWorkspaceId });
  const projects = [...new Map(all.map(item => [item.projectId ?? "inbox", item.projectName])).entries()];
  const items = all.filter(item => (kind === "all" || kind === item.kind) && (project === "all" || project === (item.projectId ?? "inbox")) &&
    (assignee === "all" || assignee === (item.assigneeUserId ?? "unassigned")) && (status === "all" || (status === "active" ? isActive(item) : status === "completed" ? isCompleted(item) : item.status === "cancelled")));
  const filtered = kind !== "all" || status !== "active" || project !== "all" || assignee !== "all";
  const create = (day = calendarDay(new Date())) => {
    const target = props.workspaceId && props.client ? { client: props.client, workspaceId: props.workspaceId, projectId: props.projectId ?? props.workspaceId, projectName: props.projectName ?? "" }
      : (() => { const source = props.projects?.find(value => value.id === project) ?? props.projects?.[0]; return source ? { ...source, projectId: source.id, projectName: source.name } : null; })();
    if (target) setEditing({ ...target, item: null, day });
  };
  const canCreate = Boolean(props.workspaceId || props.projects?.length);
  const open = async (item: CalendarOccurrence) => {
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
    : anchor.toLocaleDateString(currentLocale(), { month: "long", year: "numeric" });
  const secondaryKinds: CalendarOccurrence["kind"][] = ["journal", "freebusy"];
  const kindOptions = [{ value: "all", label: t("calendar.all_types") }, { value: "deadline", label: t("calendar.deadline") }, { value: "task", label: t("calendar.task") }, { value: "event", label: t("calendar.event") },
    ...secondaryKinds.filter(value => all.some(item => item.kind === value)).map(value => ({ value, label: calendarKindLabel(value) }))];
  const projectOptions = [{ value: "all", label: t("calendar.all_projects_short") }, ...projects.map(([value, label]) => ({ value, label }))];
  if (project !== "all" && !projectOptions.some(option => option.value === project)) projectOptions.push({ value: project, label: t("calendar.selected_project") });

  return <div className="@container/calendar h-full min-h-0 overflow-y-auto bg-background">
    <div className="lw-page-content lw-page-top space-y-5 pb-8">
      <SectionHeading size="page" title={t("calendar.title")} description={!props.workspaceId ? t("calendar.all_projects_short") : undefined} action={<>
        <Button variant="outline" disabled={!props.client} onClick={() => setSubscriptionOpen(true)}><Link2 />{t("calendar.subscribe")}</Button>
        {canCreate && <Button disabled={!props.client} onClick={() => create()}><Plus />{t("calendar.add")}</Button>}
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("common.refresh")} disabled={query.isFetching} onClick={refresh} />}><RefreshCw className={cn(query.isFetching && "animate-spin")} /></TooltipTrigger><TooltipContent>{t("common.refresh")}</TooltipContent></Tooltip>
        {props.workspaceId && <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("calendar.more_actions")} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={records.isPending || records.isError} onClick={() => setTrashOpen(true)}><Trash2 />{t("calendar.trash")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      </>} />
      <Tabs value={view} onValueChange={value => { if (value === "week" || value === "month" || value === "agenda") setView(value); }} className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t(view === "week" ? "calendar.previous_week" : "calendar.previous")} onClick={() => setAnchor(moveCalendar(anchor, view, -1))}><ChevronLeft /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t(view === "week" ? "calendar.next_week" : "calendar.next")} onClick={() => setAnchor(moveCalendar(anchor, view, 1))}><ChevronRight /></Button>
            <h2 className="mx-2 text-sm font-medium" aria-live="polite">{title}</h2>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setAnchor(new Date())}>{t("calendar.today")}</Button>
          </div>
          <TabsList aria-label={t("calendar.view")} className="h-8!">
            <TabsTrigger className="px-2.5 text-xs" value="week">{t("calendar.week")}</TabsTrigger>
            <TabsTrigger className="px-2.5 text-xs" value="month">{t("calendar.month")}</TabsTrigger>
            <TabsTrigger className="px-2.5 text-xs" value="agenda">{t("calendar.agenda")}</TabsTrigger>
          </TabsList>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-3">
          <FilterSelect icon={Tags} label={t("calendar.type")} value={kind} active={kind !== "all"} onChange={setKind} options={kindOptions} />
          <FilterSelect icon={ListFilter} label={t("calendar.status")} value={status} active={status !== "active"} onChange={setStatus} options={[{ value: "active", label: t("calendar.active") }, { value: "completed", label: t("calendar.completed") }, { value: "all", label: t("calendar.all_statuses") }]} />
          {!props.workspaceId && <FilterSelect icon={FolderOpen} label={t("calendar.project")} value={project} active={project !== "all"} onChange={setProject} options={projectOptions} />}
          {Boolean(members.data?.length) && <FilterSelect icon={UserRound} label={t("calendar.assignee")} value={assignee} active={assignee !== "all"} onChange={setAssignee} options={[{ value: "all", label: t("calendar.all_assignees") }, { value: "unassigned", label: t("calendar.unassigned") }, ...taskMemberOptions(members.data ?? [])]} />}
          {filtered && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => { setKind("all"); setStatus("active"); setProject("all"); setAssignee("all"); }}><X className="size-3" />{t("calendar.clear_filters")}</Button>}
          {opening && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" aria-label={t("calendar.loading")} />}
        </div>
        {props.client && props.workspaceId && records.data?.conflicts.map(remote => {
          const current = records.data.items.find(item => item.id === remote.id);
          return current ? <CalendarConflict key={remote.id} current={current} remote={remote} client={props.client!} workspaceId={props.workspaceId!} onChanged={refresh} /> : null;
        })}
        {query.data?.unavailable.length ? <p role="status" className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">{t("calendar.unavailable_projects", { projects: query.data.unavailable.join(", ") })}</p> : null}
        {query.isError || records.isError ? <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 p-4 text-sm"><span>{calendarError(query.error ?? records.error)}</span><Button size="sm" variant="outline" onClick={refresh}>{t("workspace_files.try_again")}</Button></div> : null}
        {query.isPending ? <div role="status" className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("calendar.loading")}</div> : <>
          <TabsContent value="week"><CalendarGrid view="week" anchor={anchor} start={range.start} items={items} projectId={props.projectId ?? props.workspaceId} showProjects={!props.workspaceId} onOpen={item => void open(item)} onCreate={canCreate ? create : undefined} /></TabsContent>
          <TabsContent value="month"><CalendarGrid view="month" anchor={anchor} start={range.start} items={items} projectId={props.projectId ?? props.workspaceId} showProjects={!props.workspaceId} onOpen={item => void open(item)} onCreate={canCreate ? create : undefined} /></TabsContent>
          <TabsContent value="agenda"><CalendarAgenda from={range.from} items={items} projectId={props.projectId ?? props.workspaceId} showProjects={!props.workspaceId} onOpen={item => void open(item)} /></TabsContent>
        </>}
      </Tabs>
      {trashOpen && props.client && props.workspaceId && <CalendarTrash client={props.client} workspaceId={props.workspaceId} items={records.data?.items.filter(item => item.deletedAt) ?? []} onClose={() => setTrashOpen(false)} onChanged={refresh} />}
      {subscriptionOpen && props.client && <CalendarSubscriptionDialog client={props.client} workspaceId={props.workspaceId ?? null} projectName={props.projectName} hasRemoteProjects={!props.workspaceId && Boolean(props.remoteSources?.length)} onClose={() => setSubscriptionOpen(false)} />}
      {task && <TaskDialog taskId={task.id} client={task.client} workspaceId={task.workspaceId} projects={task.projects} onClose={() => setTask(null)} />}
      {editing && <DeadlineDialog key={editing.item?.id ?? editing.day} client={editing.client} workspaceId={editing.workspaceId} projectId={editing.projectId} projectName={editing.projectName} projects={props.projects} item={editing.item} day={editing.day} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </div>
  </div>;
}

function CalendarGrid(props: { view: "week" | "month"; anchor: Date; start: Date; items: CalendarOccurrence[]; projectId?: string; showProjects: boolean; onOpen: (item: CalendarOccurrence) => void; onCreate?: (day: string) => void }) {
  const week = props.view === "week", today = calendarDay(new Date());
  return <div className="@container/calendar-grid">
    <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground @min-[700px]/calendar-grid:hidden"><MoveHorizontal className="size-3.5 shrink-0" />{t("calendar.scroll_days")}</p>
    <div tabIndex={0} role="region" aria-label={t(week ? "calendar.week" : "calendar.month")} className="overflow-x-auto rounded-xl border border-border/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
    <div className="grid min-w-[700px] grid-cols-7">
      {Array.from({ length: 7 }, (_, index) => {
        const day = shiftDay(props.start, index), key = calendarDay(day);
        return <div key={key} className={cn("border-b border-r border-border/60 px-3 py-3 last:border-r-0", week && key === today ? "bg-primary/5" : "bg-muted/20")}>
          <p className={cn("text-xs", key === today && week ? "font-medium text-foreground" : "text-muted-foreground")}>{day.toLocaleDateString(currentLocale(), { weekday: "short" })}</p>
          {week && <p className={cn("mt-1.5 flex size-7 items-center justify-center rounded-full text-sm font-medium tabular-nums", key === today && "bg-foreground text-background")}>{day.getDate()}</p>}
        </div>;
      })}
      {Array.from({ length: week ? 7 : 42 }, (_, index) => {
        const day = shiftDay(props.start, index), key = calendarDay(day), entries = props.items.filter(item => occursOnDay(item, key));
        const allDay = entries.filter(item => item.allDay), timed = entries.filter(item => !item.allDay);
        return <div key={key} className={cn("group/day relative min-w-0 border-r border-border/60 p-2 nth-[7n]:border-r-0", week ? "min-h-80" : "min-h-28 border-b", !week && day.getMonth() !== props.anchor.getMonth() && "bg-muted/20", week && key === today && "bg-primary/[0.02]")}>
          {!week && <div className="mb-1.5 flex items-center justify-between"><span className={cn("flex size-6 items-center justify-center rounded-full text-xs tabular-nums", key === today && "bg-foreground text-background")}>{day.getDate()}</span>{props.onCreate && <DayAdd day={key} onCreate={props.onCreate} />}</div>}
          <div className="space-y-1.5">
            {week && allDay.length > 0 && <p className="px-1 pb-1 text-[10px] text-muted-foreground">{t("calendar.all_day")}</p>}
            {allDay.map(item => <CalendarEntry key={item.id} item={item} projectId={props.projectId} compact={!week} showProject={props.showProjects} onOpen={() => props.onOpen(item)} />)}
            {week && timed.length > 0 && <p className={cn("px-1 pb-1 text-[10px] text-muted-foreground", allDay.length > 0 && "pt-3")}>{t("calendar.scheduled")}</p>}
            {timed.map(item => <CalendarEntry key={item.id} item={item} projectId={props.projectId} compact={!week} showProject={props.showProjects} onOpen={() => props.onOpen(item)} />)}
          </div>
          {week && props.onCreate && <div className="mt-3 flex justify-center"><DayAdd day={key} onCreate={props.onCreate} /></div>}
        </div>;
      })}
    </div>
    </div>
  </div>;
}

function DayAdd({ day, onCreate }: { day: string; onCreate: (day: string) => void }) {
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover/day:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" aria-label={t("calendar.add_on_day", { date: formatCalendarDay(day, { dateStyle: "full" }) })} onClick={() => onCreate(day)} />}><Plus className="size-3" /></TooltipTrigger><TooltipContent>{t("calendar.add")}</TooltipContent></Tooltip>;
}

function CalendarAgenda({ from, items, projectId, showProjects, onOpen }: { from: string; items: CalendarOccurrence[]; projectId?: string; showProjects: boolean; onOpen: (item: CalendarOccurrence) => void }) {
  const visibleDay = (item: CalendarOccurrence) => occurrenceDay(item) < from ? from : occurrenceDay(item);
  const days = [...new Set(items.map(visibleDay))].sort();
  if (!days.length) return <Empty className="min-h-64"><EmptyHeader><EmptyMedia variant="icon"><CalendarDays /></EmptyMedia><EmptyTitle>{t("calendar.empty_title")}</EmptyTitle><EmptyDescription>{t("calendar.empty")}</EmptyDescription></EmptyHeader></Empty>;
  return <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">{days.map(day => <section key={day} className="grid gap-3 p-4 @min-[640px]/calendar:grid-cols-[140px_1fr]">
    <h3 className="pt-2 text-xs font-medium"><time dateTime={day}>{formatCalendarDay(day, { weekday: "short", day: "numeric", month: "short" })}</time></h3>
    <div className="min-w-0 space-y-1.5">{items.filter(item => visibleDay(item) === day).map(item => <CalendarEntry key={item.id} item={item} projectId={projectId} showProject={showProjects} onOpen={() => onOpen(item)} />)}</div>
  </section>)}</div>;
}
