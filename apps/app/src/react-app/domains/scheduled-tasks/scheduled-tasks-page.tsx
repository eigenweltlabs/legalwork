import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarClock, Clock3, FileCheck2, ListChecks, Loader2, Plus, Search } from "lucide-react";
import type { ScheduledTask, ScheduledTaskInput } from "@legalwork/types/scheduled-tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { IconTile, SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ScheduledTaskDialog, ScheduleSelect, type ScheduleClient, type ScheduleProject } from "./scheduled-task-dialog";
import { formatRunTime, runStatusLabel, scheduleLabel, taskStatusLabel } from "./schedule-format";

export function ScheduledTasksPage({ client, projects, defaultModel, openTaskId, onOpenSession }: {
  client: ScheduleClient | null; projects: ScheduleProject[]; defaultModel?: ScheduledTaskInput["model"];
  openTaskId?: string | null; onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(openTaskId ?? null);
  const [editing, setEditing] = useState<ScheduledTask | "new" | null>(null);
  const [initial, setInitial] = useState<{ title: string; prompt: string }>();
  const tasks = useQuery({ queryKey: ["scheduled-tasks", client?.baseUrl], enabled: Boolean(client), queryFn: () => client!.scheduledTasks(), refetchInterval: 15000 });
  const selected = tasks.data?.tasks.find(task => task.id === selectedId);
  const detail = useQuery({ queryKey: ["scheduled-task", client?.baseUrl, selected?.workspaceId, selectedId], enabled: Boolean(client && selected), queryFn: () => client!.scheduledTask(selected!.workspaceId, selected!.id), refetchInterval: 15000 });
  const current = detail.data?.task ?? selected;
  useEffect(() => { if (openTaskId) setSelectedId(openTaskId); }, [openTaskId]);
  const refresh = () => { void cache.invalidateQueries({ queryKey: ["scheduled-tasks"] }); void cache.invalidateQueries({ queryKey: ["scheduled-task"] }); };
  const shown = tasks.data?.tasks.filter(task => (filter === "all" || task.status === filter) && `${task.title} ${task.prompt}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const create = (suggestion?: { title: string; prompt: string }) => { setInitial(suggestion); setEditing("new"); };
  return <div className="@container flex h-full min-h-0 w-full flex-col bg-background">
    <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
      <aside className="flex max-h-[40%] min-h-56 shrink-0 flex-col border-b border-border bg-sidebar/40 @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0">
        <div className="space-y-4 p-5"><SectionHeading title={t("scheduled.title")} action={<Button variant="ghost" size="icon-sm" aria-label={t("scheduled.new")} disabled={!client || !projects.length} onClick={() => create()}><Plus className="size-4" /></Button>} />
          <div className="relative"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label={t("scheduled.search")} placeholder={t("scheduled.search")} className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
          <ScheduleSelect label={t("scheduled.filter")} value={filter} onChange={setFilter} options={[{ value: "all", label: t("scheduled.all") }, { value: "active", label: t("scheduled.active") }, { value: "paused", label: t("scheduled.paused") }, { value: "completed", label: t("scheduled.completed") }]} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {tasks.isLoading && <p role="status" className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("scheduled.loading")}</p>}
          {tasks.isError && <div role="alert" className="px-3 text-sm"><p className="text-destructive">{t("scheduled.load_failed")}</p><Button variant="ghost" size="sm" onClick={() => void tasks.refetch()}>{t("scheduled.retry")}</Button></div>}
          {!tasks.isLoading && !tasks.isError && !shown.length && <p className="px-3 py-4 text-sm text-muted-foreground">{t(search || filter !== "all" ? "scheduled.no_matches" : "scheduled.empty_list")}</p>}
          {shown.map(task => <button key={task.id} onClick={() => setSelectedId(task.id)} aria-pressed={selectedId === task.id} className={cn("flex w-full min-w-0 gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selectedId === task.id && "bg-sidebar-accent")}>
            <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{task.status === "active" && task.nextRunAt ? formatRunTime(task.nextRunAt, task.schedule.timeZone) : taskStatusLabel(task.status)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{scheduleLabel(task.schedule)}</span></span>
          </button>)}
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6 @3xl:p-10">
        {current ? <div className="mx-auto max-w-2xl space-y-7 lw-fade-enter" key={current.id}>
          <SectionHeading size="page" title={current.title} description={projects.find(project => project.id === current.workspaceId)?.name} action={<Button variant="outline" disabled={detail.isError || detail.isLoading} onClick={() => setEditing(current)}>{t("scheduled.edit")}</Button>} />
          <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{taskStatusLabel(current.status)}</Badge><span className="text-sm text-muted-foreground">{scheduleLabel(current.schedule)} · {current.schedule.timeZone}</span></div>
          {detail.isError && <p role="alert" className="text-sm text-destructive">{t("scheduled.load_failed")}</p>}
          {current.nextRunAt && current.status === "active" && <Surface variant="inset" className="flex items-center gap-3 p-4"><IconTile variant="glass"><CalendarClock /></IconTile><div><p className="text-xs text-muted-foreground">{t("scheduled.next_run")}</p><p className="mt-1 text-sm font-medium">{formatRunTime(current.nextRunAt, current.schedule.timeZone)}</p></div></Surface>}
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">{t("scheduled.project_access")}</span><span>{t(current.projectAccess === "all" ? "scheduled.access_all" : "scheduled.access_project")}</span></div>
          <section><h2 className="mb-3 text-sm font-medium">{t("scheduled.instructions")}</h2><p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{current.prompt}</p></section>
          <div className="flex items-center justify-between gap-4 border-y border-border py-4"><span className="text-sm text-muted-foreground">{t("scheduled.runs_in")}</span>{current.sessionId ? <Button variant="ghost" size="sm" onClick={() => onOpenSession(current.workspaceId, current.sessionId!)}>{t("scheduled.open_chat")}<ArrowUpRight className="size-4" /></Button> : <span className="text-sm">{t(current.reuseChat ? "scheduled.same_chat_each" : "scheduled.new_chat_each")}</span>}</div>
          <section><SectionHeading title={t("scheduled.history")} description={t("scheduled.history_hint")} />
            <div className="mt-4 divide-y divide-border">{detail.data?.runs.map(run => <div key={run.id} className="flex items-start gap-3 py-4"><Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">{runStatusLabel(run.status)}</p><p className="mt-1 text-xs text-muted-foreground">{formatRunTime(run.startedAt, current.schedule.timeZone)} · {t(run.projectAccess === "all" ? "scheduled.access_all" : "scheduled.access_project")}</p>{run.error && <p className="mt-2 text-xs text-destructive">{run.error}</p>}{run.status === "dispatching" && <p className="mt-2 text-xs text-muted-foreground">{t("scheduled.unconfirmed_hint")}</p>}</div>{run.sessionId && <Button variant="ghost" size="sm" onClick={() => onOpenSession(current.workspaceId, run.sessionId!)}>{t("scheduled.open")}<ArrowUpRight className="size-3.5" /></Button>}</div>)}
              {detail.data?.runs.length === 0 && <p className="py-4 text-sm text-muted-foreground">{t("scheduled.no_runs")}</p>}
            </div></section>
        </div> : <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center py-8 lw-enter">
          <IconTile size="lg" variant="glass"><CalendarClock /></IconTile><h1 className="mt-5 text-2xl font-semibold tracking-tight">{t("scheduled.welcome")}</h1><p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{t("scheduled.description")}</p>
          <div className="mt-6"><Button disabled={!client || !projects.length} onClick={() => create()}><Plus className="size-4" />{t("scheduled.new")}</Button></div>
          {!client ? <p className="mt-4 text-sm text-muted-foreground">{t("scheduled.disconnected")}</p> : !projects.length && <p className="mt-4 text-sm text-muted-foreground">{t("scheduled.no_projects")}</p>}
          <div className="mt-10 grid gap-3 @xl:grid-cols-2">{[{ key: "brief", Icon: ListChecks, title: t("scheduled.template_brief"), prompt: t("scheduled.template_brief_prompt"), description: t("scheduled.template_brief_description") }, { key: "review", Icon: FileCheck2, title: t("scheduled.template_review"), prompt: t("scheduled.template_review_prompt"), description: t("scheduled.template_review_description") }].map(({ key, Icon, title, prompt, description }) => <button key={key} disabled={!client || !projects.length} onClick={() => create({ title, prompt })} className="group rounded-2xl border border-border p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Icon className="size-5 text-muted-foreground" strokeWidth={1.6} /><h2 className="mt-4 text-sm font-medium">{title}</h2><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p></button>)}</div>
          <p className="mt-8 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Clock3 className="mt-0.5 size-3.5 shrink-0" />{t("scheduled.local_detail")}</p>
        </div>}
      </main>
    </div>
    {editing && client && <ScheduledTaskDialog client={client} projects={projects} task={editing === "new" ? null : editing} initial={initial} defaultModel={defaultModel} onClose={() => setEditing(null)} onSaved={refresh} />}
  </div>;
}
