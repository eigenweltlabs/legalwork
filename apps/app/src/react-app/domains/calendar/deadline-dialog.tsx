import { useId, useState } from "react";
import { ArrowUpRight, FolderOpen, Bell, ChevronRight, Circle, ExternalLink, Loader2, Timer, Trash2 } from "lucide-react";
import type { CalendarItem } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { useNavigate } from "react-router-dom";
import { workspaceProjectRoute } from "../../shell/workspace-routes";
import { DeadlineLinks } from "./deadline-links";
import type { CalendarSource } from "./calendar-queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { AssigneeMark } from "../tasks/task-glyphs";
import { DueDateChip, PropertyChip } from "../tasks/task-property-chip";
import { taskMemberOptions } from "../tasks/task-format";
import { useTaskMembers } from "../tasks/tasks-queries";
import { calendarError, formatCalendarDay } from "./calendar-format";

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
  const busy = saving || deleting || uploading;
  const reminderItems = [
    { value: "none", label: t("calendar.reminder_none") }, { value: "0", label: t("calendar.at_start") },
    { value: "60", label: t("calendar.reminder_hour") }, { value: "1440", label: t("calendar.reminder_day") }, { value: "10080", label: t("calendar.reminder_week") },
  ];
  if (!reminderItems.some(option => option.value === originalReminder)) reminderItems.push({ value: originalReminder, label: t("calendar.minutes_before", { count: Number(originalReminder) }) });
  const statusItems = [{ value: "active", label: t("calendar.active") }, { value: "completed", label: t("calendar.completed") }];
  if (item?.status === "cancelled") statusItems.push({ value: "cancelled", label: t("calendar.cancelled") });
  const save = async () => {
    if (busy || !title.trim() || !day || (needsReason && !reason.trim())) return;
    setSaving(true);
    try {
      const reminders = reminder === "none" ? [] : [Number(reminder)];
      const body = item ? { attachmentPaths, sessionIds, revision: item.revision, title: title.trim(), description, status, verified, assigneeUserId: assignee === UNASSIGNED ? null : assignee,
        ...(day !== item.start?.slice(0, 10) ? { start: day, end: null } : {}), ...(timeZone !== item.timeZone ? { timeZone } : {}),
        ...(needsReason ? { reason: reason.trim() } : {}),
        ...(item.provenance.kind === "manual" && source !== originalSource ? { source } : {}),
        ...(reminder !== originalReminder ? { reminders } : {}) }
        : { attachmentPaths, sessionIds, title: title.trim(), description, start: day, timeZone, kind: "deadline", source, assigneeUserId: assignee === UNASSIGNED ? null : assignee, reminders };
      await client.calendarWrite(workspaceId, item ? `/${item.id}` : "", body, item ? "PATCH" : "POST");
      toast.success(t(item ? "calendar.saved" : "calendar.created"));
      props.onSaved();
    } catch (error) { toast.error(calendarError(error)); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!item || busy) return;
    setDeleting(true);
    try {
      await client.calendarWrite(workspaceId, `/${item.id}/delete`, { revision: item.revision });
      toast.success(t("calendar.deleted")); props.onSaved();
    } catch (error) { toast.error(calendarError(error)); } finally { setDeleting(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) props.onClose(); }}>
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl">
      <form className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); void save(); }}>
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 py-4 pr-14">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium"><Timer className="size-4 text-muted-foreground" />{t(item ? "calendar.edit" : "calendar.add")}</DialogTitle>
          <DialogDescription className="sr-only">{t("calendar.manual_hint")}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={saving || deleting} className="min-h-0 min-w-0 space-y-4 overflow-y-auto px-6 py-5">
          {Boolean(props.projects?.length) && <div className="flex min-w-0 items-center gap-2">
            {!item ? <PropertyChip label={t("calendar.project")} value={project.id} disabled={busy}
              items={(props.projects ?? []).map(value => ({ value: value.id, label: value.name, leading: <FolderOpen className="size-3.5" /> }))}
              onChange={value => { const next = props.projects?.find(entry => entry.id === value); if (next) { setProject(next); setAttachmentPaths([]); setSessionIds([]); setAssignee(UNASSIGNED); } }} />
            : <Button type="button" variant="ghost" size="sm" className="h-7 min-w-0 max-w-full justify-start px-0 text-xs font-normal text-muted-foreground" title={project.name} disabled={busy} onClick={() => { props.onClose(); navigate(workspaceProjectRoute(project.id)); }}><FolderOpen className="size-3.5 shrink-0" /><span className="truncate">{project.name}</span><ArrowUpRight className="size-3 shrink-0" /></Button>}
          </div>}
          <div className="space-y-3">
            <Input id={ids.title} aria-label={t("calendar.name")} autoFocus required maxLength={1000} placeholder={t("calendar.title_placeholder")} value={title} onChange={event => setTitle(event.target.value)}
              className="h-auto rounded-md border-transparent bg-transparent px-0 py-1 text-xl font-medium leading-snug tracking-tight shadow-none md:text-xl hover:enabled:border-transparent focus-visible:border-transparent focus-visible:ring-0" />
            <Textarea id={ids.description} aria-label={t("tasks.field_description")} rows={2} maxLength={20000} placeholder={t("calendar.description_placeholder")} value={description} onChange={event => setDescription(event.target.value)}
              className="min-h-16 max-h-40 rounded-md border-transparent bg-transparent px-0 py-1 text-sm shadow-none hover:enabled:border-transparent focus-visible:border-transparent focus-visible:ring-0" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DueDateChip value={day} disabled={advanced || busy} onChange={value => setDay(value ?? "")} />
            <PropertyChip label={t("calendar.reminder")} value={reminder} disabled={busy} items={reminderItems.map(option => ({ ...option, leading: <Bell className="size-3.5 text-muted-foreground" /> }))} onChange={setReminder} />
            {Boolean(members.data?.length || item?.assigneeUserId) && <PropertyChip label={t("calendar.assignee")} value={assignee} disabled={busy}
              items={assigneeItems.map(option => ({ ...option, leading: <AssigneeMark name={option.value === UNASSIGNED ? null : option.primary} /> }))} onChange={setAssignee} />}
            {item && <PropertyChip label={t("calendar.status")} value={status} disabled={busy} items={statusItems.map(option => ({ ...option, leading: <Circle className="size-3.5 text-muted-foreground" /> }))}
              onChange={value => { if (value === "active" || value === "completed" || value === "cancelled") setStatus(value); }} />}
          </div>
          {advanced && <p className="text-xs leading-5 text-muted-foreground">{t("calendar.advanced_hint")}</p>}
          <div className="border-t border-border/60 pt-3">
            <DeadlineLinks key={project.id} client={client} workspaceId={workspaceId} projectId={project.id} attachmentPaths={attachmentPaths} sessionIds={sessionIds} disabled={saving || deleting}
              onAttachments={setAttachmentPaths} onSessions={setSessionIds} onBusy={setUploading} onClose={props.onClose} />
          </div>
          <Collapsible>
            <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-7 justify-start gap-1.5 px-0 text-xs font-normal text-muted-foreground" />}><ChevronRight className="size-3.5" />{t("calendar.more_details")}</CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pb-1 pt-3">
              {(!item || item.provenance.kind === "manual") && <div className="flex flex-col gap-1.5"><Label htmlFor={ids.source}>{t("calendar.source")}</Label><Input id={ids.source} maxLength={4000} placeholder={t("calendar.source_placeholder")} value={source} onChange={event => setSource(event.target.value)} /></div>}
              <div className="flex flex-col gap-1.5"><Label htmlFor={ids.timeZone}>{t("calendar.timezone")}</Label><Input id={ids.timeZone} required disabled={advanced} value={timeZone} onChange={event => setTimeZone(event.target.value)} /></div>
            </CollapsibleContent>
          </Collapsible>
          {needsReason && <div className="flex flex-col gap-1.5"><Label htmlFor={ids.reason}>{t("calendar.override_reason")}</Label><Textarea id={ids.reason} required maxLength={4000} rows={2} value={reason} onChange={event => setReason(event.target.value)} /></div>}
          {item && item.provenance.kind !== "manual" && <div className="flex items-center gap-2"><Checkbox id={ids.reviewed} checked={verified} onCheckedChange={setVerified} /><Label htmlFor={ids.reviewed} className="text-xs">{t("calendar.verified")}</Label></div>}
          {item && <CalculationDetails item={item} />}
        </fieldset>
        <DialogFooter className="m-0 shrink-0 px-6 py-4">
          {item && <Button type="button" variant="ghost" className="sm:mr-auto" disabled={busy} onClick={() => void remove()}>{deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}{t("calendar.delete")}</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !title.trim() || !day || (needsReason && !reason.trim())} aria-busy={saving}>{saving && <Loader2 className="animate-spin" />}{t(item ? "calendar.save" : "calendar.add")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
