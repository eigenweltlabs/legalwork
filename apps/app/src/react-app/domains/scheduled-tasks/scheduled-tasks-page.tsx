import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search } from "lucide-react";
import type { ScheduledTask, ScheduledTaskInput } from "@legalwork/types/scheduled-tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/react-app/design-system/surface";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ScheduledTaskDialog, ScheduledTaskEditor, ScheduleSelect, type ScheduleClient, type ScheduleProject, type ScheduledTaskDraft } from "./scheduled-task-dialog";
import { ScheduledTasksWelcome } from "./scheduled-tasks-welcome";
import { ScheduledTaskDetail } from "./scheduled-task-detail";
import { ScheduledTaskListItem } from "./scheduled-task-list-item";
import { DeleteScheduledTaskDialog } from "./delete-scheduled-task-dialog";

export function ScheduledTasksPage({ client, projects, defaultModel, openTaskId, onOpenSession }: {
  client: ScheduleClient | null; projects: ScheduleProject[]; defaultModel?: ScheduledTaskInput["model"];
  openTaskId?: string | null; onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(openTaskId ?? null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [initial, setInitial] = useState<ScheduledTaskDraft>();
  const tasks = useQuery({ queryKey: ["scheduled-tasks", client?.baseUrl], enabled: Boolean(client), queryFn: () => client!.scheduledTasks(), refetchInterval: 15000 });
  const selected = tasks.data?.tasks.find(task => task.id === selectedId);
  const detail = useQuery({ queryKey: ["scheduled-task", client?.baseUrl, selected?.workspaceId, selectedId], enabled: Boolean(client && selected), queryFn: () => client!.scheduledTask(selected!.workspaceId, selected!.id), refetchInterval: 15000 });
  const current = selected ? detail.data?.task ?? selected : undefined;
  const projectName = (task: ScheduledTask) => projects.find(project => project.id === task.workspaceId)?.name ?? task.workspaceId;
  useEffect(() => { if (openTaskId) { setSelectedId(openTaskId); setEditing(null); setDirty(false); } }, [openTaskId]);
  const refresh = () => { void cache.invalidateQueries({ queryKey: ["scheduled-tasks"] }); void cache.invalidateQueries({ queryKey: ["scheduled-task"] }); };
  const shown = tasks.data?.tasks.filter(task => (filter === "all" || task.status === filter) && `${task.title} ${task.prompt} ${projectName(task)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const closeEditor = () => { setEditing(null); setDirty(false); };
  const leaveEditor = (action: () => void) => {
    if (busy) return;
    if (dirty) { toast.info(t("scheduled.finish_editing")); return; }
    closeEditor(); action();
  };
  const edit = (task: ScheduledTask) => {
    if (editing?.id === task.id) return;
    leaveEditor(() => { setSelectedId(task.id); setEditing(task); });
  };
  const create = (suggestion?: ScheduledTaskDraft) => leaveEditor(() => { setInitial(suggestion); setCreating(true); });
  const saved = (task: ScheduledTask) => {
    cache.setQueryData<{ tasks: ScheduledTask[] }>(["scheduled-tasks", client?.baseUrl], data => data && ({ tasks: data.tasks.some(item => item.id === task.id) ? data.tasks.map(item => item.id === task.id ? task : item) : [...data.tasks, task] }));
    cache.setQueryData<Awaited<ReturnType<ScheduleClient["scheduledTask"]>>>(["scheduled-task", client?.baseUrl, task.workspaceId, task.id], data => data && ({ ...data, task }));
    setSelectedId(task.id); refresh();
  };
  const toggle = async (task: ScheduledTask) => {
    if (!client || busy || task.status === "completed") return;
    setBusy(true);
    try { await client.updateScheduledTask(task.workspaceId, task.id, task.revision, { status: task.status === "active" ? "paused" : "active" }); }
    catch (failure) { toast.error(failure instanceof Error ? failure.message : t("scheduled.save_failed")); }
    finally { setBusy(false); refresh(); }
  };
  return <div className="@container flex h-full min-h-0 w-full flex-col bg-background">
    <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
      <aside className="flex max-h-[40%] min-h-56 shrink-0 flex-col border-b border-border bg-sidebar/40 @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0">
        <div className="space-y-4 p-5"><SectionHeading title={t("scheduled.title")} action={<Button variant="ghost" size="icon-sm" aria-label={t("scheduled.new")} disabled={!client || !projects.length || busy} onClick={() => create()}><Plus className="size-4" /></Button>} />
          <div className="relative"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label={t("scheduled.search")} placeholder={t("scheduled.search")} className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
          <ScheduleSelect label={t("scheduled.filter")} value={filter} onChange={setFilter} options={[{ value: "all", label: t("scheduled.all") }, { value: "active", label: t("scheduled.active") }, { value: "paused", label: t("scheduled.paused") }, { value: "completed", label: t("scheduled.completed") }]} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {tasks.isLoading && <p role="status" className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("scheduled.loading")}</p>}
          {tasks.isError && <div role="alert" className="px-3 text-sm"><p className="text-destructive">{t("scheduled.load_failed")}</p><Button variant="ghost" size="sm" onClick={() => void tasks.refetch()}>{t("scheduled.retry")}</Button></div>}
          {!tasks.isLoading && !tasks.isError && !shown.length && <p className="px-3 py-4 text-sm text-muted-foreground">{t(search || filter !== "all" ? "scheduled.no_matches" : "scheduled.empty_list")}</p>}
          {shown.map(task => <ScheduledTaskListItem key={task.id} task={task} projectName={projectName(task)} selected={selectedId === task.id} disabled={!client || busy}
            onSelect={() => { if (selectedId !== task.id) leaveEditor(() => setSelectedId(task.id)); }} onEdit={() => edit(task)} onToggle={() => leaveEditor(() => void toggle(task))} onDelete={() => leaveEditor(() => setDeleting(task))} />)}
        </div>
      </aside>
      <main key={current?.id ?? "welcome"} className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto px-6 @3xl:px-10", !(editing && client) && "py-6 @3xl:py-10")}>
        {editing && client ? <ScheduledTaskEditor key={editing.id} client={client} projects={projects} task={editing} onClose={closeEditor} onSaved={saved} onBusyChange={setBusy} onDirtyChange={setDirty} />
          : current ? <ScheduledTaskDetail key={current.id} task={current} assistant={projects.find(project => project.id === current.workspaceId)?.assistant} projectName={projectName(current)} runs={detail.data?.runs} loading={detail.isLoading} error={detail.isError} busy={busy}
          onEdit={() => edit(current)} onToggle={() => void toggle(current)} onDelete={() => setDeleting(current)} onOpenSession={onOpenSession} />
          : <ScheduledTasksWelcome connected={Boolean(client)} hasProjects={Boolean(projects.length)} assistantWorkspaceId={projects.find(project => project.assistant)?.id} onCreate={create} />}
      </main>
    </div>
    {deleting && client && <DeleteScheduledTaskDialog client={client} task={deleting} onClose={() => setDeleting(null)} onDeleted={() => {
      if (selectedId === deleting.id) setSelectedId(null);
      cache.removeQueries({ queryKey: ["scheduled-task", client.baseUrl, deleting.workspaceId, deleting.id] });
      setDeleting(null); refresh();
    }} />}
    {creating && client && <ScheduledTaskDialog client={client} projects={projects} initial={initial} defaultModel={defaultModel} onClose={() => setCreating(false)} onSaved={saved} />}
  </div>;
}
