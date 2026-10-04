import { useId, useRef, useState } from "react";
import { ArrowUpRight, FolderOpen, Bell, CalendarDays, ChevronDown, ChevronRight, ListFilter, Circle, CircleCheck, ExternalLink, Loader2, MessageSquarePlus, Timer, Trash2 } from "lucide-react";
import type { CalendarItem } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { useNavigate } from "react-router-dom";
import { workspaceProjectRoute } from "../../shell/workspace-routes";
import { DeadlineLinks } from "./deadline-links";
import type { CalendarSource } from "./calendar-queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ItemDetailLabel, ItemDescriptionInput, ItemDialogContent, ItemTitleInput } from "@/react-app/design-system/item-detail";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { AssigneeMark } from "../tasks/task-glyphs";
import { DueDateChip, PropertyChip } from "../tasks/task-property-chip";
import { taskMemberOptions } from "../tasks/task-format";
import { useTaskMembers } from "../tasks/tasks-queries";
import { calendarError, calendarKindLabel, formatCalendarDay } from "./calendar-format";
import { useWorkspace } from "../../shell/workspace-provider";
import { startCalendarSession } from "./start-calendar-session";

const UNASSIGNED = "__unassigned__";

export function CalculationDetails({ item }: { item: CalendarItem }) {
  if (item.provenance.kind !== "calculated") return null;
  const calculation = item.provenance.calculation;
  return <Collapsible className="rounded-xl border border-border/60">
    <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-10 w-full justify-start gap-2 px-3 text-xs font-normal" />}>
      <ChevronRight className="size-3.5 transition-transform in-aria-expanded:rotate-90" />{t("calendar.calculation")}
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-3 border-t border-border/60 px-4 py-3 text-xs leading-relaxed">
      <p className="font-medium">{formatCalendarDay(calculation.deadlineDay, { dateStyle: "long" })} · {calculation.timeZone}</p>
      <ol className="list-decimal space-y-2 pl-4">{calculation.trace.map((line, index) => <li key={index}>{line}</li>)}</ol>
      <div className="space-y-1">{calculation.sources.map(url => <a key={url} className="flex items-center gap-1.5 break-all text-muted-foreground underline underline-offset-4 hover:text-foreground" href={url} target="_blank" rel="noreferrer"><ExternalLink className="size-3 shrink-0" />{url}</a>)}</div>
    </CollapsibleContent>
  </Collapsible>;
}

export function DeadlineDialog(props: { client: LegalworkServerClient; workspaceId: string; projectId: string; projectName: string; projects?: CalendarSource[]; item: CalendarItem | null; day: string; onClose: () => void; onSaved: () => void }) {
  const item = props.item, navigate = useNavigate();
  const sessionContext = useWorkspace();
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [project, setProject] = useState<CalendarSource>({ id: props.projectId, name: props.projectName, workspaceId: props.workspaceId, client: props.client });
  const { client, workspaceId } = project;
  const [attachmentPaths, setAttachmentPaths] = useState(item?.attachmentPaths ?? []), [sessionIds, setSessionIds] = useState(item?.sessionIds ?? []);
  const [uploading, setUploading] = useState(false);
  const ids = { title: useId(), description: useId(), source: useId(), timeZone: useId(), reason: useId(), reviewed: useId() };
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [day, setDay] = useState(item?.start?.slice(0, 10) ?? props.day);
  const originalSource = item?.provenance.kind === "manual" ? item.provenance.source : "";
  const [source, setSource] = useState(originalSource), [reason, setReason] = useState("");
  const [timeZone, setTimeZone] = useState(item?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [saving, setSaving] = useState(false), [deleting, setDeleting] = useState(false);
  const [revision, setRevision] = useState(item?.revision ?? 0);
  const [status, setStatus] = useState(item?.status ?? "active"), [verified, setVerified] = useState(item?.verified ?? false);
  const originalReminder = item ? item.reminders.length ? String(item.reminders[0]) : "none" : "1440";
  const [reminder, setReminder] = useState(originalReminder), [assignee, setAssignee] = useState(item?.assigneeUserId ?? UNASSIGNED);
  const members = useTaskMembers({ client, workspaceId });
  const assigneeItems = [{ value: UNASSIGNED, label: t("calendar.unassigned"), primary: t("calendar.unassigned"), detail: undefined }, ...taskMemberOptions(members.data ?? [])];
  if (assignee !== UNASSIGNED && !assigneeItems.some(option => option.value === assignee)) {
    assigneeItems.push({ value: assignee, label: t("calendar.assigned_member"), primary: t("calendar.assigned_member"), detail: undefined });
  }
  const advanced = Boolean(item && (item.start?.length !== 10 || /(?:RRULE|RDATE)[;:]/i.test(item.ical)));
  const dateChanged = Boolean(item && (day !== item.start?.slice(0, 10) || timeZone !== item.timeZone));
  const needsReason = item?.provenance.kind === "calculated" && dateChanged;
  const busy = saving || deleting || uploading || starting;
  const reminderItems = [
    { value: "none", label: t("calendar.reminder_none") }, { value: "0", label: t("calendar.at_start") },
    { value: "60", label: t("calendar.reminder_hour") }, { value: "1440", label: t("calendar.reminder_day") }, { value: "10080", label: t("calendar.reminder_week") },
  ];
  if (!reminderItems.some(option => option.value === originalReminder)) reminderItems.push({ value: originalReminder, label: t("calendar.minutes_before", { count: Number(originalReminder) }) });
  const statusItems = [{ value: "active", label: t("calendar.active") }, { value: "completed", label: t("calendar.completed") }];
  if (item?.status === "cancelled") statusItems.push({ value: "cancelled", label: t("calendar.cancelled") });
  const save = async (close = true) => {
    if (busy || !title.trim() || !day || (needsReason && !reason.trim())) return;
    setSaving(true);
    try {
      const reminders = reminder === "none" ? [] : [Number(reminder)];
      const body = item ? { attachmentPaths, sessionIds, revision, title: title.trim(), description, status, verified, assigneeUserId: assignee === UNASSIGNED ? null : assignee,
        ...(day !== item.start?.slice(0, 10) ? { start: day, end: null } : {}), ...(timeZone !== item.timeZone ? { timeZone } : {}),
        ...(needsReason ? { reason: reason.trim() } : {}),
        ...(item.provenance.kind === "manual" && source !== originalSource ? { source } : {}),
        ...(reminder !== originalReminder ? { reminders } : {}) }
        : { attachmentPaths, sessionIds, title: title.trim(), description, start: day, timeZone, kind: "deadline", source, assigneeUserId: assignee === UNASSIGNED ? null : assignee, reminders };
      const result = await client.calendarWrite(workspaceId, item ? `/${item.id}` : "", body, item ? "PATCH" : "POST");
      if (result.item) setRevision(result.item.revision);
      if (close) { toast.success(t(item ? "calendar.saved" : "calendar.created")); props.onSaved(); }
      return result.item;
    } catch (error) { toast.error(calendarError(error)); } finally { setSaving(false); }
  };
  const startSession = async () => {
    if (!item || busy || startingRef.current) return;
    const workspace = sessionContext.workspaces.find(value => value.id === project.id);
    if (!workspace) { toast.error(t("tasks.linked_project_unavailable")); return; }
    startingRef.current = true;
    const saved = await save(false);
    if (!saved) { startingRef.current = false; return; }
    setStarting(true);
    try {
      const sessionId = await startCalendarSession({ item: saved, client, workspaceId, workspace, baseUrl: sessionContext.baseUrl, token: sessionContext.token });
      props.onSaved();
      sessionContext.onOpenSession(project.id, sessionId);
    } catch (error) { toast.error(calendarError(error)); }
    finally { startingRef.current = false; setStarting(false); }
  };
  const remove = async () => {
    if (!item || busy) return;
    setDeleting(true);
    try {
      await client.calendarWrite(workspaceId, `/${item.id}/delete`, { revision });
      toast.success(t("calendar.deleted")); props.onSaved();
    } catch (error) { toast.error(calendarError(error)); } finally { setDeleting(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) props.onClose(); }}>
    <ItemDialogContent>
      <form className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); void save(); }}>
        <DialogHeader className="flex-row items-center justify-between shrink-0 border-b border-border/60 px-6 py-3.5 pe-14">
          <DialogTitle><ItemDetailLabel icon={item && item.kind !== "deadline" ? <CalendarDays /> : <Timer />}>{item ? calendarKindLabel(item.kind) : t("calendar.add")}</ItemDetailLabel></DialogTitle>
          <DialogDescription className="sr-only">{t("calendar.manual_hint")}</DialogDescription>
          {item && <Button type="button" size="sm" variant="outline" disabled={busy || !title.trim() || !day || (needsReason && !reason.trim())} onClick={() => void startSession()}>
            {starting ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}{t("tasks.start_session")}
          </Button>}
        </DialogHeader>
        <fieldset disabled={busy} className="min-h-0 min-w-0 space-y-5 overflow-y-auto px-5 py-6 sm:px-8">
          <div className="space-y-4">
            <ItemTitleInput id={ids.title} aria-label={t("calendar.name")} autoFocus required maxLength={1000} placeholder={t("calendar.title_placeholder")} value={title} onChange={event => setTitle(event.target.value)} />
            <ItemDescriptionInput id={ids.description} aria-label={t("tasks.field_description")} rows={2} maxLength={20000} placeholder={t("calendar.description_placeholder")} value={description} onChange={event => setDescription(event.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2 [&>[data-slot=select-trigger]]:max-w-72">
            {item && <PropertyChip label={t("calendar.status")} value={status} disabled={busy} items={statusItems.map(option => ({ ...option, leading: option.value === "completed" ? <CircleCheck className="size-3.5 text-green-11" /> : <Circle className="size-3.5 text-muted-foreground" /> }))}
              onChange={value => { if (value === "active" || value === "completed" || value === "cancelled") setStatus(value); }} />}
            <DueDateChip value={day} disabled={advanced || busy} onChange={value => setDay(value ?? "")} />
            <PropertyChip label={t("calendar.reminder")} value={reminder} disabled={busy} items={reminderItems.map(option => ({ ...option, leading: <Bell className="size-3.5 text-muted-foreground" /> }))} onChange={setReminder} />
            {Boolean(members.data?.length || item?.assigneeUserId) && <PropertyChip label={t("calendar.assignee")} value={assignee} disabled={busy}
              items={assigneeItems.map(option => ({ ...option, leading: <AssigneeMark name={option.value === UNASSIGNED ? null : option.primary} /> }))} onChange={setAssignee} />}

            {!item && props.projects?.length ? <PropertyChip label={t("calendar.project")} value={project.id} disabled={busy}
              items={props.projects.map(value => ({ value: value.id, label: value.name, leading: <FolderOpen className="size-3.5" /> }))}
              onChange={value => { const next = props.projects?.find(entry => entry.id === value); if (next) { setProject(next); setAttachmentPaths([]); setSessionIds([]); setAssignee(UNASSIGNED); } }} />
            : <Button type="button" variant="outline" size="sm" className="h-8 max-w-full gap-2 px-2.5 text-xs" title={project.name} disabled={busy} onClick={() => { props.onClose(); navigate(workspaceProjectRoute(project.id)); }}><FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{project.name}</span><ArrowUpRight className="size-3 shrink-0 text-muted-foreground" /></Button>}
          </div>
          {advanced && <p className="text-xs leading-5 text-muted-foreground">{t("calendar.advanced_hint")}</p>}
          <div className="border-t border-border/60 pt-4">
            <DeadlineLinks key={project.id} client={client} workspaceId={workspaceId} projectId={project.id} attachmentPaths={attachmentPaths} sessionIds={sessionIds} disabled={saving || deleting}
              onAttachments={setAttachmentPaths} onSessions={setSessionIds} onBusy={setUploading} onClose={props.onClose} />
          </div>
          <Collapsible className="border-t border-border/60">
            <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-12 w-full justify-start gap-3 px-0 text-xs font-medium" />}><ListFilter className="size-4 text-muted-foreground" />{t("tasks.details")}<ChevronDown className="ms-auto size-4 text-muted-foreground transition-transform in-aria-expanded:rotate-180" /></CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pb-1 pt-3">
              {(!item || item.provenance.kind === "manual") && <div className="flex flex-col gap-1.5"><Label htmlFor={ids.source}>{t("calendar.source")}</Label><Input id={ids.source} maxLength={4000} placeholder={t("calendar.source_placeholder")} value={source} onChange={event => setSource(event.target.value)} /></div>}
              <div className="flex flex-col gap-1.5"><Label htmlFor={ids.timeZone}>{t("calendar.timezone")}</Label><Input id={ids.timeZone} required disabled={advanced} value={timeZone} onChange={event => setTimeZone(event.target.value)} /></div>
            </CollapsibleContent>
          </Collapsible>
          {needsReason && <div className="flex flex-col gap-1.5"><Label htmlFor={ids.reason}>{t("calendar.override_reason")}</Label><Textarea id={ids.reason} required maxLength={4000} rows={2} value={reason} onChange={event => setReason(event.target.value)} /></div>}
          {item && item.provenance.kind !== "manual" && <div className="flex items-center gap-2"><Checkbox id={ids.reviewed} checked={verified} onCheckedChange={setVerified} /><Label htmlFor={ids.reviewed} className="text-xs">{t("calendar.verified")}</Label></div>}
          {item && <CalculationDetails item={item} />}
        </fieldset>
        <DialogFooter className="m-0 shrink-0 border-border/60 bg-muted/20 px-6 py-3.5">
          {item && <Button type="button" variant="ghost" className="sm:mr-auto" disabled={busy} onClick={() => void remove()}>{deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}{t("calendar.delete")}</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !title.trim() || !day || (needsReason && !reason.trim())} aria-busy={saving}>{saving && <Loader2 className="animate-spin" />}{t(item ? "calendar.save" : "calendar.add")}</Button>
        </DialogFooter>
      </form>
    </ItemDialogContent>
  </Dialog>;
}
