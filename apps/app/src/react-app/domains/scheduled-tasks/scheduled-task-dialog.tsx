import type { AssistantIcon } from "@legalwork/types/main-assistant";
import { AssistantAvatar } from "../session/sidebar/assistant-appearance";
import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock3, FolderOpen, Loader2, Search } from "lucide-react";
import type { ScheduledTask, ScheduledTaskInput, TaskSchedule } from "@legalwork/types/scheduled-tasks";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ModelSelect } from "@/components/model-select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatRunTime, localDateTime, repeatMode, repeatOptions, weeklyRuleForStart } from "./schedule-format";

export type ScheduledTaskDraft = { title: string; prompt: string; schedule?: TaskSchedule; workspaceId?: string };
export type ScheduleProject = { id: string; name: string; assistant?: boolean; assistantIcon?: AssistantIcon };
export type ScheduleClient = Pick<LegalworkServerClient, "baseUrl" | "scheduledTasks" | "scheduledTask" | "scheduledTaskChats" | "previewTaskSchedule" | "createScheduledTask" | "updateScheduledTask" | "deleteScheduledTask">;

export function ScheduleSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select value={value} items={options} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next); }}>
    <SelectTrigger aria-label={label} className="min-w-0 max-w-[70%]"><SelectValue className="truncate" /></SelectTrigger>
    <SelectContent align="end" className="max-h-[min(16rem,var(--available-height))] max-w-[calc(100vw-3rem)]">{options.map(option => <SelectItem key={option.value} value={option.value}><span className="block truncate">{option.label}</span></SelectItem>)}</SelectContent>
  </Select>;
}

type ScheduledTaskEditorProps = {
  client: ScheduleClient; projects: ScheduleProject[]; task: ScheduledTask | null;
  initial?: ScheduledTaskDraft; defaultModel?: ScheduledTaskInput["model"];
  onClose: () => void; onSaved: (task: ScheduledTask) => void;
  inline?: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
};

/** Creation uses a dialog; existing tasks are edited in the detail pane. */
export function ScheduledTaskDialog(props: Omit<ScheduledTaskEditorProps, "task" | "inline" | "onBusyChange" | "onDirtyChange">) {
  const [busy, setBusy] = useState(false);
  return <Dialog open onOpenChange={open => { if (!open && !busy) props.onClose(); }}>
    <DialogContent className="flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader className="shrink-0 px-6 pb-5 pt-6"><DialogTitle>{t("scheduled.new")}</DialogTitle><DialogDescription>{t("scheduled.local_hint")}</DialogDescription></DialogHeader>
      <ScheduledTaskEditor {...props} task={null} inline={false} onBusyChange={setBusy} />
    </DialogContent>
  </Dialog>;
}

export function ScheduledTaskEditor({ client, projects, task, initial, defaultModel, onClose, onSaved, inline = true, onBusyChange, onDirtyChange }: ScheduledTaskEditorProps) {
  const cache = useQueryClient();
  const id = useId();
  const initialSchedule = task?.schedule ?? initial?.schedule;
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? initial?.workspaceId ?? "");
  const assistantTarget = projects.find(project => project.id === workspaceId)?.assistant === true;
  const [projectAccess, setProjectAccess] = useState<ScheduledTaskInput["projectAccess"]>(task?.projectAccess ?? "project");
  const [model, setModel] = useState<ScheduledTaskInput["model"]>(task ? task.model : defaultModel ?? null);
  const [modelOpen, setModelOpen] = useState(false);
  const [pinSession, setPinSession] = useState(task?.pinSession ?? true);
  const [title, setTitle] = useState(task?.title ?? initial?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? initial?.prompt ?? "");
  const [zone, setZone] = useState(initialSchedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState(() => localDateTime(initialSchedule?.startAt ?? new Date(Date.now() + 3600000).toISOString(), zone));
  const [mode, setMode] = useState<string>(initialSchedule ? repeatMode(initialSchedule) : "daily");
  const [minutes, setMinutes] = useState(initialSchedule?.kind === "interval" ? String(initialSchedule.minutes) : "60");
  const [rule, setRule] = useState(initialSchedule?.kind === "rrule" ? initialSchedule.rrule : "FREQ=WEEKLY;BYDAY=MO");
  const [sessionId, setSessionId] = useState<string | null>(task?.sessionId ?? null);
  const [reuseChat, setReuseChat] = useState(task ? Boolean(task.sessionId) || task.reuseChat : true);
  const [projectOpen, setProjectOpen] = useState(false), [projectSearch, setProjectSearch] = useState("");
  const [selectedChatTitle, setSelectedChatTitle] = useState<string>();
  const [chatOpen, setChatOpen] = useState(false), [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [scheduleEdited, setScheduleEdited] = useState(false);
  const common = { startAt: `${start}:00`, timeZone: zone };
  const draftSchedule: TaskSchedule = mode === "once" ? { kind: "once", ...common }
    : mode === "interval" ? { kind: "interval", ...common, minutes: Number(minutes) }
    : { kind: "rrule", ...common, rrule: mode === "daily" ? "FREQ=DAILY" : mode === "weekdays" ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : mode === "weekly" ? weeklyRuleForStart(start, initialSchedule) : rule };
  const schedule = task && !scheduleEdited ? task.schedule : draftSchedule;
  const scheduleKey = JSON.stringify(schedule);
  const [previewKey, setPreviewKey] = useState(scheduleKey);
  useEffect(() => { const timer = setTimeout(() => setPreviewKey(scheduleKey), 300); return () => clearTimeout(timer); }, [scheduleKey]);
  const preview = useQuery({ queryKey: ["schedule-preview", client.baseUrl, workspaceId, previewKey], enabled: Boolean(workspaceId) && previewKey === scheduleKey,
    retry: false, queryFn: () => client.previewTaskSchedule(workspaceId, schedule) });
  const chats = useQuery({ queryKey: ["scheduled-chats", client.baseUrl, workspaceId, search], enabled: Boolean(workspaceId) && !assistantTarget, queryFn: () => client.scheduledTaskChats(workspaceId, search) });
  const selectedChat = chats.data?.sessions.find(chat => chat.id === sessionId)?.title ?? selectedChatTitle;
  const changed = (action: () => void) => { setScheduleEdited(true); action(); };
  const dirty = Boolean(task && (pinSession !== task.pinSession || title !== task.title || prompt !== task.prompt || projectAccess !== task.projectAccess || sessionId !== task.sessionId || reuseChat !== (Boolean(task.sessionId) || task.reuseChat) || scheduleKey !== JSON.stringify(task.schedule) || model?.providerID !== task.model?.providerID || model?.modelID !== task.model?.modelID));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const save = async () => {
    setBusy(true); onBusyChange?.(true); setError(null);
    try {
      const input: ScheduledTaskInput = { title, prompt, schedule, sessionId: assistantTarget ? null : sessionId, reuseChat: assistantTarget ? false : reuseChat, projectAccess: assistantTarget ? "all" : projectAccess, model, pinSession: assistantTarget ? false : pinSession };
      const saved = task ? await client.updateScheduledTask(workspaceId, task.id, task.revision, input) : await client.createScheduledTask(workspaceId, input);
      onSaved(saved.task); onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("scheduled.save_failed"));
      // Keep this draft's revision fixed, but make reopening use the latest task.
      if (task) {
        void cache.invalidateQueries({ queryKey: ["scheduled-task", client.baseUrl, workspaceId, task.id] });
        void cache.invalidateQueries({ queryKey: ["scheduled-tasks", client.baseUrl] });
      }
    }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  const valid = title.trim() && prompt.trim() && workspaceId && (task || model) && !preview.isError && (task && !scheduleEdited || preview.data?.occurrences.length) && previewKey === scheduleKey && !preview.isFetching;
  const modelPicker = <Surface className="flex items-center justify-between gap-4 p-4"><Label>{t("settings.model")}</Label><div className="min-w-0 max-w-[70%]"><ModelSelect open={modelOpen} value={model ?? { providerID: "", modelID: "" }} onOpenChange={setModelOpen} onChange={setModel} disabled={busy} showManageModels={false} /></div></Surface>;
  const actions = <><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("scheduled.cancel")}</Button><Button type="submit" disabled={!valid || busy} aria-busy={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t("scheduled.save")}</Button></>;
  return <form aria-label={t(task ? "scheduled.edit" : "scheduled.new")} className={cn("@container/editor flex min-h-0 flex-col", inline ? "mx-auto max-w-4xl gap-6 py-6 @3xl:py-10" : "flex-1")} onSubmit={event => { event.preventDefault(); if (valid && !busy) void save(); }}>
        {inline && <header className="sticky top-0 z-10 space-y-3 border-b border-border bg-background pb-4 pt-1">
          <SectionHeading size="page" title={t("scheduled.edit")} action={actions} />
          <p className="flex items-start gap-2 text-xs text-muted-foreground"><FolderOpen className="size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{t("scheduled.project")}: {projects.find(project => project.id === workspaceId)?.name ?? workspaceId}</span>{dirty && <span className="shrink-0" role="status">{t("common.unsaved_changes")}</span>}</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </header>}
        <div className={cn("min-h-0", !inline && "flex-1 overflow-y-auto px-6 pb-4")}><fieldset disabled={busy} className="min-w-0 space-y-5">
          {!task && <div className="space-y-2"><Label htmlFor={`${id}-project`}>{t("assistant.destination")}</Label>
            <Popover open={projectOpen} onOpenChange={setProjectOpen}><PopoverTrigger render={<Button autoFocus id={`${id}-project`} type="button" variant="outline" aria-label={t("assistant.destination")} className="h-auto min-h-9 w-full justify-start text-left font-normal" />}>{assistantTarget ? <AssistantAvatar icon={projects.find(project => project.id === workspaceId)?.assistantIcon} /> : <FolderOpen className="size-4 shrink-0 text-muted-foreground" />}<span className={cn("min-w-0 flex-1 whitespace-normal break-words", !workspaceId && "text-muted-foreground")}>{projects.find(project => project.id === workspaceId)?.name ?? t("assistant.choose_destination")}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></PopoverTrigger>
              <PopoverContent align="start" className="flex max-h-[min(18rem,var(--available-height))] w-[var(--anchor-width)] max-w-[calc(100vw-3rem)] flex-col gap-2 p-2">
                <Input autoFocus aria-label={t("scheduled.search_projects")} placeholder={t("scheduled.search_projects")} value={projectSearch} onChange={event => setProjectSearch(event.target.value)} />
                <div className="min-h-0 overflow-y-auto">{projects.filter(project => project.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase())).sort((a, b) => Number(Boolean(b.assistant)) - Number(Boolean(a.assistant))).map(project => <Button type="button" key={project.id} variant={project.id === workspaceId ? "secondary" : "ghost"} aria-pressed={project.id === workspaceId} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left font-normal" onClick={() => { setWorkspaceId(project.id); setSessionId(null); setSelectedChatTitle(undefined); setSearch(""); setProjectOpen(false); setProjectSearch(""); }}>{project.assistant && <AssistantAvatar icon={project.assistantIcon} />}<span className="min-w-0 break-words">{project.name}</span></Button>)}
                  {!projects.some(project => project.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase())) && <p className="p-2 text-xs text-muted-foreground">{t("scheduled.no_projects_found")}</p>}
                </div>
              </PopoverContent>
            </Popover>
          </div>}
          {assistantTarget ? <p className="text-sm text-muted-foreground">{t("assistant.schedule_hint")}</p> : <Surface className="flex flex-wrap items-center justify-between gap-3 p-4">
            <Label>{t("scheduled.project_access")}</Label><ScheduleSelect label={t("scheduled.project_access")} value={projectAccess} options={[{ value: "project", label: t("scheduled.access_project") }, { value: "all", label: t("scheduled.access_all") }]} onChange={value => setProjectAccess(value === "all" ? "all" : "project")} />
          </Surface>}
          <div className="space-y-2"><Label htmlFor={`${id}-title`}>{t("scheduled.name")}</Label><Input autoFocus={Boolean(task)} id={`${id}-title`} value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder={t("scheduled.name_placeholder")} required /></div>
          <div className="space-y-2"><Label htmlFor={`${id}-prompt`}>{t("scheduled.instructions")}</Label><Textarea id={`${id}-prompt`} className="min-h-32 max-h-64 resize-y leading-relaxed" value={prompt} maxLength={30000} onChange={event => setPrompt(event.target.value)} placeholder={t("scheduled.prompt_placeholder")} required /></div>
          {!task && modelPicker}
          <Surface className="divide-y divide-border">
            <div className="flex items-center justify-between gap-3 p-4"><Label>{t("scheduled.repeat")}</Label><ScheduleSelect label={t("scheduled.repeat")} value={mode} options={repeatOptions()} onChange={value => changed(() => setMode(value))} /></div>
            {mode === "interval" && <div className="flex items-center justify-between gap-4 p-4"><Label htmlFor={`${id}-minutes`}>{t("scheduled.interval_minutes")}</Label><Input id={`${id}-minutes`} type="number" min={1} max={525600} className="w-28" value={minutes} onChange={event => changed(() => setMinutes(event.target.value))} /></div>}
            <div className="grid gap-3 p-4 @md/editor:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-start`}>{t(mode === "once" ? "scheduled.run_at" : "scheduled.starts")}</Label><Input id={`${id}-start`} type="datetime-local" value={start} onChange={event => changed(() => setStart(event.target.value))} required /></div>
              <div className="space-y-2"><Label htmlFor={`${id}-zone`}>{t("scheduled.time_zone")}</Label><Input id={`${id}-zone`} value={zone} onChange={event => changed(() => setZone(event.target.value))} required /></div></div>
            {mode === "custom" && <div className="space-y-2 p-4"><Label htmlFor={`${id}-rule`}>RRULE</Label><Input id={`${id}-rule`} className="font-mono text-xs" value={rule} onChange={event => changed(() => setRule(event.target.value))} /><p className="text-xs text-muted-foreground">{t("scheduled.rule_hint")}</p></div>}
          </Surface>
          {workspaceId && <div aria-live="polite" className="flex gap-2 text-xs leading-relaxed text-muted-foreground"><Clock3 className="mt-0.5 size-3.5 shrink-0" />
            <div>{previewKey !== scheduleKey || preview.isFetching ? t("scheduled.loading") : preview.isError ? <span className="text-destructive">{preview.error.message}</span> : preview.data?.occurrences[0] ? <>{t("scheduled.next_run")}: {formatRunTime(preview.data.occurrences[0], schedule.timeZone)} · {schedule.timeZone}</> : t("scheduled.no_future_run")}</div>
          </div>}
          <Collapsible><CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}><ChevronDown className="size-4" />{t("scheduled.advanced")}</CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              {task && modelPicker}
              {!assistantTarget && <><Surface className="flex items-center justify-between gap-4 p-4"><Label htmlFor={`${id}-pin`}>{t("scheduled.pin_session")}</Label><Switch id={`${id}-pin`} checked={pinSession} onCheckedChange={setPinSession} disabled={busy} /></Surface>
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
              {!sessionId && reuseChat && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t("scheduled.same_chat_hint")}</p>}</>}
            </CollapsibleContent>
          </Collapsible>
          {error && !inline && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </fieldset></div>
        {!inline && <div className="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4">{actions}</div>}
      </form>;
}
