import { ArrowUpRight, CalendarClock, Check, Clock3, FileText, FolderOpen, MessageSquare, Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { ScheduledRun, ScheduledTask } from "@legalwork/types/scheduled-tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconTile, SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { formatRunTime, runStatusLabel, scheduleLabel, taskStatusLabel } from "./schedule-format";

export function ScheduledTaskDetail({ task, projectName, runs, loading, error, busy, onEdit, onToggle, onDelete, onOpenSession }: {
  task: ScheduledTask; projectName: string; runs: ScheduledRun[] | undefined; loading: boolean; error: boolean; busy: boolean;
  onEdit: () => void; onToggle: () => void; onDelete: () => void; onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
  const disabled = loading || error || busy;
  return <div className="@container/detail mx-auto max-w-4xl space-y-6 lw-fade-enter">
    <header className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarClock className="size-4" />{t("scheduled.task")}<span aria-hidden="true">/</span><Badge variant="secondary" className={cn(task.status === "active" && "bg-green-3 text-green-11")}>{taskStatusLabel(task.status)}</Badge></div>
      <SectionHeading size="page" title={task.title} className="[&_h1]:break-words" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={disabled} onClick={onEdit}><Pencil className="size-3.5" />{t("scheduled.edit")}</Button>
        {task.status !== "completed" && <Button variant="outline" size="sm" disabled={disabled} onClick={onToggle}>{task.status === "active" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{t(task.status === "active" ? "scheduled.pause" : "scheduled.resume")}</Button>}
        <Button variant="ghost" size="sm" disabled={disabled} className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}><Trash2 className="size-3.5" />{t("scheduled.delete")}</Button>
      </div>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{t("scheduled.load_failed")}</p>}
    <Surface className="grid divide-y divide-border @lg/detail:grid-cols-2 @lg/detail:divide-x @lg/detail:divide-y-0">
      <div className="flex gap-3 p-5"><IconTile size="sm" variant="inset" className="text-blue-11"><CalendarClock /></IconTile><div className="min-w-0">
        <p className="text-xs text-muted-foreground">{t("scheduled.next_run")}</p>
        <p className="mt-1.5 text-sm font-medium">{task.status === "active" && task.nextRunAt ? formatRunTime(task.nextRunAt, task.schedule.timeZone) : taskStatusLabel(task.status)}</p>
        <p className="mt-2 text-xs text-muted-foreground">{scheduleLabel(task.schedule)} · {task.schedule.timeZone}</p>
      </div></div>
      <div className="flex gap-3 p-5"><IconTile size="sm" variant="inset" className="text-violet-11"><FolderOpen /></IconTile><div className="min-w-0">
        <p className="text-xs text-muted-foreground">{t("scheduled.project")}</p><p className="mt-1.5 break-words text-sm font-medium">{projectName}</p>
        <p className="mt-2 break-words text-xs text-muted-foreground">{t(task.projectAccess === "all" ? "scheduled.detail_access_all" : "scheduled.detail_access_project", { project: projectName })}</p>
      </div></div>
    </Surface>
    <Surface className="overflow-hidden">
      <section className="p-5"><h2 className="mb-3 flex items-center gap-2 text-sm font-medium"><FileText className="size-4 text-muted-foreground" />{t("scheduled.instructions")}</h2><p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/80">{task.prompt}</p></section>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-5 py-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><MessageSquare className="size-4" />{t("scheduled.runs_in")}</div>{task.sessionId ? <Button variant="ghost" size="sm" onClick={() => onOpenSession(task.workspaceId, task.sessionId!)}>{t("scheduled.open_chat")}<ArrowUpRight className="size-3.5" /></Button> : <span className="text-xs">{t(task.reuseChat ? "scheduled.same_chat_each" : "scheduled.new_chat_each")}</span>}</div>
    </Surface>
    <section><SectionHeading title={t("scheduled.history")} description={t("scheduled.history_hint")} />
      {loading && <p role="status" className="mt-4 text-sm text-muted-foreground">{t("scheduled.loading")}</p>}
      <div className="mt-4 divide-y divide-border">{runs?.map(run => <div key={run.id} className="flex items-start gap-3 py-4"><IconTile size="sm" variant="inset" className={cn(run.status === "sent" && "text-green-11", run.status === "failed" && "text-destructive")}>{run.status === "sent" ? <Check /> : <Clock3 />}</IconTile><div className="min-w-0 flex-1"><p className="text-sm font-medium">{runStatusLabel(run.status)}</p><p className="mt-1 text-xs text-muted-foreground">{formatRunTime(run.startedAt, task.schedule.timeZone)} · {t(run.projectAccess === "all" ? "scheduled.access_all" : "scheduled.detail_access_project", { project: projectName })}</p>{run.error && <p className="mt-2 text-xs text-destructive">{run.error}</p>}{run.status === "dispatching" && <p className="mt-2 text-xs text-muted-foreground">{t("scheduled.unconfirmed_hint")}</p>}</div>{run.sessionId && <Button variant="ghost" size="sm" onClick={() => onOpenSession(task.workspaceId, run.sessionId!)}>{t("scheduled.open")}<ArrowUpRight className="size-3.5" /></Button>}</div>)}</div>
      {runs?.length === 0 && <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-4"><Clock3 className="size-4 shrink-0 text-muted-foreground" /><div><p className="text-sm">{t("scheduled.no_runs")}</p><p className="mt-1 text-xs text-muted-foreground">{t("scheduled.first_run_hint")}</p></div></div>}
    </section>
  </div>;
}
