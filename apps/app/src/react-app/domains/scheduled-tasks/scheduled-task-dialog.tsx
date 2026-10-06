import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Clock3, Loader2, Search, Trash2 } from "lucide-react";
import type { ScheduledTask, ScheduledTaskInput, TaskSchedule } from "@legalwork/types/scheduled-tasks";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Surface } from "@/react-app/design-system/surface";
import { t } from "@/i18n";
import { DeleteScheduledTaskDialog } from "./delete-scheduled-task-dialog";
import { formatRunTime, localDateTime, repeatMode, repeatOptions } from "./schedule-format";

export type ScheduledTaskDraft = { title: string; prompt: string; schedule?: TaskSchedule };
export type ScheduleProject = { id: string; name: string };
export type ScheduleClient = Pick<LegalworkServerClient, "baseUrl" | "scheduledTasks" | "scheduledTask" | "scheduledTaskChats" | "previewTaskSchedule" | "createScheduledTask" | "updateScheduledTask" | "deleteScheduledTask">;

export function ScheduleSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select value={value} items={options} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next); }}>
    <SelectTrigger aria-label={label} className="min-w-0 max-w-[70%]"><SelectValue className="truncate" /></SelectTrigger>
    <SelectContent align="end" className="max-h-[min(16rem,var(--available-height))] max-w-[calc(100vw-3rem)]">{options.map(option => <SelectItem key={option.value} value={option.value}><span className="block truncate">{option.label}</span></SelectItem>)}</SelectContent>
  </Select>;
}

export function ScheduledTaskDialog({ client, projects, task, initial, defaultModel, onClose, onSaved }: {
  client: ScheduleClient; projects: ScheduleProject[]; task: ScheduledTask | null;
  initial?: ScheduledTaskDraft; defaultModel?: ScheduledTaskInput["model"];
  onClose: () => void; onSaved: () => void;
}) {
  const id = useId();
  const initialSchedule = task?.schedule ?? initial?.schedule;
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? projects[0]?.id ?? "");
  const [projectAccess, setProjectAccess] = useState<ScheduledTaskInput["projectAccess"]>(task?.projectAccess ?? "project");
  const [title, setTitle] = useState(task?.title ?? initial?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? initial?.prompt ?? "");
  const [zone, setZone] = useState(initialSchedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState(() => localDateTime(initialSchedule?.startAt ?? new Date(Date.now() + 3600000).toISOString(), zone));
  const [mode, setMode] = useState<string>(initialSchedule ? repeatMode(initialSchedule) : "daily");
  const [minutes, setMinutes] = useState(initialSchedule?.kind === "interval" ? String(initialSchedule.minutes) : "60");
  const [rule, setRule] = useState(initialSchedule?.kind === "rrule" ? initialSchedule.rrule : "FREQ=WEEKLY;BYDAY=MO");
  const [ruleDraft, setRuleDraft] = useState(rule), [ruleOpen, setRuleOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(task?.sessionId ?? null);
  const [reuseChat, setReuseChat] = useState(task ? Boolean(task.sessionId) || task.reuseChat : true);
  const [projectOpen, setProjectOpen] = useState(false), [projectSearch, setProjectSearch] = useState("");
  const [selectedChatTitle, setSelectedChatTitle] = useState<string>();
  const [chatOpen, setChatOpen] = useState(false), [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleEdited, setScheduleEdited] = useState(false);
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(`${start.slice(0, 10)}T12:00:00Z`).getUTCDay()];
  const common = { startAt: `${start}:00`, timeZone: zone };
  const draftSchedule: TaskSchedule = mode === "once" ? { kind: "once", ...common }
    : mode === "interval" ? { kind: "interval", ...common, minutes: Number(minutes) }
    : { kind: "rrule", ...common, rrule: mode === "daily" ? "FREQ=DAILY" : mode === "weekdays" ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : mode === "weekly" ? `FREQ=WEEKLY;BYDAY=${weekday}` : rule };
  const schedule = task && !scheduleEdited ? task.schedule : draftSchedule;
  const scheduleKey = JSON.stringify(schedule);
  const [previewKey, setPreviewKey] = useState(scheduleKey);
  useEffect(() => { const timer = setTimeout(() => setPreviewKey(scheduleKey), 300); return () => clearTimeout(timer); }, [scheduleKey]);
  const preview = useQuery({ queryKey: ["schedule-preview", client.baseUrl, workspaceId, previewKey], enabled: Boolean(workspaceId) && previewKey === scheduleKey,
    retry: false, queryFn: () => client.previewTaskSchedule(workspaceId, schedule) });
  const chats = useQuery({ queryKey: ["scheduled-chats", client.baseUrl, workspaceId, search], enabled: Boolean(workspaceId), queryFn: () => client.scheduledTaskChats(workspaceId, search) });
  const selectedChat = chats.data?.sessions.find(chat => chat.id === sessionId)?.title ?? selectedChatTitle;
  const changed = (action: () => void) => { setScheduleEdited(true); action(); };
  const save = async (status?: "active" | "paused") => {
    setBusy(true); setError(null);
    try {
      const input: ScheduledTaskInput = { title, prompt, schedule, sessionId, reuseChat, projectAccess, model: task ? task.model : defaultModel ?? null };
      if (task) await client.updateScheduledTask(workspaceId, task.id, task.revision, status ? { status } : input);
      else await client.createScheduledTask(workspaceId, input);
      onSaved(); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("scheduled.save_failed")); }
    finally { setBusy(false); }
  };
  const valid = title.trim() && prompt.trim() && workspaceId && !preview.isError && (task && !scheduleEdited || preview.data?.occurrences.length) && previewKey === scheduleKey && !preview.isFetching;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-2xl">
      <DialogHeader className="shrink-0 px-6 pb-5 pt-6"><DialogTitle>{t(task ? "scheduled.edit" : "scheduled.new")}</DialogTitle><DialogDescription>{t("scheduled.local_hint")}</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); if (valid && !busy) void save(); }}>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4"><fieldset disabled={busy} className="min-w-0 space-y-5">
          <div className="space-y-2"><Label htmlFor={`${id}-title`}>{t("scheduled.name")}</Label><Input autoFocus id={`${id}-title`} value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder={t("scheduled.name_placeholder")} required /></div>
          <div className="space-y-2"><Label htmlFor={`${id}-prompt`}>{t("scheduled.instructions")}</Label><Textarea id={`${id}-prompt`} className="min-h-32 max-h-64 resize-y leading-relaxed" value={prompt} maxLength={30000} onChange={event => setPrompt(event.target.value)} placeholder={t("scheduled.prompt_placeholder")} required /></div>
          <Surface className="divide-y divide-border">
            <div className="flex items-center justify-between gap-3 p-4"><Label>{t("scheduled.repeat")}</Label><ScheduleSelect label={t("scheduled.repeat")} value={mode} options={repeatOptions()} onChange={value => changed(() => setMode(value))} /></div>
            {mode === "interval" && <div className="flex items-center justify-between gap-4 p-4"><Label htmlFor={`${id}-minutes`}>{t("scheduled.interval_minutes")}</Label><Input id={`${id}-minutes`} type="number" min={1} max={525600} className="w-28" value={minutes} onChange={event => changed(() => setMinutes(event.target.value))} /></div>}
            <div className="grid gap-3 p-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-start`}>{t(mode === "once" ? "scheduled.run_at" : "scheduled.starts")}</Label><Input id={`${id}-start`} type="datetime-local" value={start} onChange={event => changed(() => setStart(event.target.value))} required /></div>
              <div className="space-y-2"><Label htmlFor={`${id}-zone`}>{t("scheduled.time_zone")}</Label><Input id={`${id}-zone`} value={zone} onChange={event => changed(() => setZone(event.target.value))} required /></div></div>
            {mode === "custom" && <div className="flex min-w-0 items-center gap-3 p-4"><code className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={rule}>{rule}</code><Button type="button" variant="ghost" size="sm" onClick={() => { setRuleDraft(rule); setRuleOpen(true); }}>{t("scheduled.edit_rule")}</Button></div>}
          </Surface>
          <div aria-live="polite" className="flex gap-2 text-xs leading-relaxed text-muted-foreground"><Clock3 className="mt-0.5 size-3.5 shrink-0" />
            <div>{previewKey !== scheduleKey || preview.isFetching ? t("scheduled.loading") : preview.isError ? <span className="text-destructive">{preview.error.message}</span> : preview.data?.occurrences[0] ? <>{t("scheduled.next_run")}: {formatRunTime(preview.data.occurrences[0], schedule.timeZone)} · {schedule.timeZone}</> : t("scheduled.no_future_run")}</div>
          </div>
          <Collapsible><CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}><ChevronDown className="size-4" />{t("scheduled.advanced")}</CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <Surface className="flex items-center justify-between gap-4 p-4"><Label>{t("scheduled.project")}</Label>
                <Popover open={projectOpen} onOpenChange={setProjectOpen}><PopoverTrigger disabled={Boolean(task)} render={<Button type="button" variant="ghost" aria-label={t("scheduled.project")} className="min-w-0 max-w-[70%] font-normal" />}><span className="truncate">{projects.find(project => project.id === workspaceId)?.name}</span><ChevronDown className="size-4 shrink-0" /></PopoverTrigger>
                  <PopoverContent align="end" className="flex max-h-[min(18rem,var(--available-height))] w-80 max-w-[calc(100vw-3rem)] flex-col gap-2 p-2">
                    <Input autoFocus aria-label={t("scheduled.search_projects")} placeholder={t("scheduled.search_projects")} value={projectSearch} onChange={event => setProjectSearch(event.target.value)} />
                    <div className="min-h-0 overflow-y-auto">{projects.filter(project => project.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase())).map(project => <Button type="button" key={project.id} variant={project.id === workspaceId ? "secondary" : "ghost"} aria-pressed={project.id === workspaceId} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left font-normal" onClick={() => { setWorkspaceId(project.id); setSessionId(null); setSelectedChatTitle(undefined); setSearch(""); setProjectOpen(false); setProjectSearch(""); }}><span className="min-w-0 break-words">{project.name}</span></Button>)}
                      {!projects.some(project => project.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase())) && <p className="p-2 text-xs text-muted-foreground">{t("scheduled.no_projects_found")}</p>}
                    </div>
                  </PopoverContent>
                </Popover>
              </Surface>
              <Surface className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><Label>{t("scheduled.project_access")}</Label><ScheduleSelect label={t("scheduled.project_access")} value={projectAccess} options={[{ value: "project", label: t("scheduled.access_project") }, { value: "all", label: t("scheduled.access_all") }]} onChange={value => setProjectAccess(value === "all" ? "all" : "project")} /></div>
                <p className="text-xs leading-relaxed text-muted-foreground">{t(projectAccess === "project" ? "scheduled.access_project_hint" : "scheduled.access_all_hint", { project: projects.find(project => project.id === workspaceId)?.name ?? t("scheduled.project") })}</p>
              </Surface>

              <Surface className="flex items-center justify-between gap-4 p-4"><Label>{t("scheduled.runs_in")}</Label>
                <Popover open={chatOpen} onOpenChange={setChatOpen}><PopoverTrigger render={<Button type="button" variant="ghost" aria-label={t("scheduled.runs_in")} className="min-w-0 max-w-[70%] font-normal" />}><span className="truncate">{sessionId ? selectedChat ?? t("scheduled.selected_chat") : t(reuseChat ? "scheduled.same_chat_each" : "scheduled.new_chat_each")}</span><ChevronDown className="size-4 shrink-0" /></PopoverTrigger>
                  <PopoverContent className="flex max-h-[min(22rem,var(--available-height))] w-80 max-w-[calc(100vw-3rem)] flex-col p-2" align="end"><div className="relative mb-2 shrink-0"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input autoFocus aria-label={t("scheduled.search_chats")} placeholder={t("scheduled.search_chats")} className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
                    <div className="min-h-0 overflow-y-auto">
                      <Button type="button" variant={!sessionId && reuseChat ? "secondary" : "ghost"} aria-pressed={!sessionId && reuseChat} className="w-full justify-start font-normal" onClick={() => { setSessionId(null); setReuseChat(true); setChatOpen(false); }}>{t("scheduled.same_chat_each")}</Button>
                      <Button type="button" variant={!sessionId && !reuseChat ? "secondary" : "ghost"} aria-pressed={!sessionId && !reuseChat} className="w-full justify-start font-normal" onClick={() => { setSessionId(null); setReuseChat(false); setChatOpen(false); }}>{t("scheduled.new_chat_each")}</Button>
                      {chats.data?.sessions.map(chat => <Button type="button" key={chat.id} variant={chat.id === sessionId ? "secondary" : "ghost"} className="w-full justify-start font-normal" onClick={() => { setSessionId(chat.id); setSelectedChatTitle(chat.title); setReuseChat(true); setChatOpen(false); setSearch(""); }}><span className="truncate">{chat.title}</span></Button>)}
                      {chats.isError && <p role="alert" className="p-2 text-xs text-destructive">{t("scheduled.chats_failed")}</p>}
                      {chats.isLoading && <p role="status" className="p-2 text-xs text-muted-foreground">{t("scheduled.loading")}</p>}
                      {chats.data?.sessions.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t("scheduled.no_chats")}</p>}
                    </div></PopoverContent>
                </Popover></Surface>
              {!sessionId && reuseChat && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t("scheduled.same_chat_hint")}</p>}
            </CollapsibleContent>
          </Collapsible>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </fieldset></div>
        <DialogFooter className="mx-0 mb-0 shrink-0 flex-row justify-end border-t border-border px-6 py-4">
          {task && <Button type="button" variant="ghost" size="sm" className="mr-auto text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" />{t("scheduled.delete")}</Button>}
          {task && task.status !== "completed" && <Button type="button" variant="secondary" disabled={busy} onClick={() => void save(task.status === "active" ? "paused" : "active")}>{t(task.status === "active" ? "scheduled.pause" : "scheduled.resume")}</Button>}
          <Button type="submit" disabled={!valid || busy} aria-busy={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t("scheduled.save")}</Button>
        </DialogFooter>
      </form>
      <Dialog open={ruleOpen} onOpenChange={setRuleOpen}><DialogContent><DialogHeader><DialogTitle>{t("scheduled.edit_rule")}</DialogTitle><DialogDescription>{t("scheduled.rule_hint")}</DialogDescription></DialogHeader><Label htmlFor={`${id}-rule`}>RRULE</Label><Input id={`${id}-rule`} className="font-mono text-xs" value={ruleDraft} onChange={event => setRuleDraft(event.target.value)} /><DialogFooter><Button variant="ghost" onClick={() => setRuleOpen(false)}>{t("scheduled.cancel")}</Button><Button onClick={() => { changed(() => setRule(ruleDraft)); setRuleOpen(false); }}>{t("scheduled.apply")}</Button></DialogFooter></DialogContent></Dialog>
      {confirmDelete && task && <DeleteScheduledTaskDialog client={client} task={task} onClose={() => setConfirmDelete(false)} onDeleted={() => { onSaved(); onClose(); }} />}
    </DialogContent>
  </Dialog>;
}
