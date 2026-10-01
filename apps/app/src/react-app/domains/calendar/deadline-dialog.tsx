import { useId, useState } from "react";
import { Bell, ChevronRight, ExternalLink, Loader2, Trash2 } from "lucide-react";
import type { CalendarItem } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { AssigneeMark, OptionText } from "../tasks/task-glyphs";
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

export function DeadlineDialog(props: { client: LegalworkServerClient; workspaceId: string; item: CalendarItem | null; day: string; onClose: () => void; onSaved: () => void }) {
  const item = props.item;
  const ids = { title: useId(), description: useId(), day: useId(), source: useId(), timeZone: useId(), reason: useId(), reminder: useId(), assignee: useId(), status: useId(), reviewed: useId() };
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
  const members = useTaskMembers({ client: props.client, workspaceId: props.workspaceId });
  const assigneeItems = [{ value: UNASSIGNED, label: t("calendar.unassigned"), primary: t("calendar.unassigned"), detail: undefined }, ...taskMemberOptions(members.data ?? [])];
  if (assignee !== UNASSIGNED && !assigneeItems.some(option => option.value === assignee)) {
    assigneeItems.push({ value: assignee, label: t("calendar.assigned_member"), primary: t("calendar.assigned_member"), detail: undefined });
  }
  const chosenAssignee = assigneeItems.find(option => option.value === assignee);
  const advanced = Boolean(item && (item.start?.length !== 10 || /(?:RRULE|RDATE)[;:]/i.test(item.ical)));
  const dateChanged = Boolean(item && (day !== item.start?.slice(0, 10) || timeZone !== item.timeZone));
  const needsReason = item?.provenance.kind === "calculated" && dateChanged;
  const busy = saving || deleting;
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
      const body = item ? { revision: item.revision, title: title.trim(), description, status, verified, assigneeUserId: assignee === UNASSIGNED ? null : assignee,
        ...(day !== item.start?.slice(0, 10) ? { start: day, end: null } : {}), ...(timeZone !== item.timeZone ? { timeZone } : {}),
        ...(needsReason ? { reason: reason.trim() } : {}),
        ...(item.provenance.kind === "manual" && source !== originalSource ? { source } : {}),
        ...(reminder !== originalReminder ? { reminders } : {}) }
        : { title: title.trim(), description, start: day, timeZone, kind: "deadline", source, assigneeUserId: assignee === UNASSIGNED ? null : assignee, reminders };
      await props.client.calendarWrite(props.workspaceId, item ? `/${item.id}` : "", body, item ? "PATCH" : "POST");
      toast.success(t(item ? "calendar.saved" : "calendar.created"));
      props.onSaved();
    } catch (error) { toast.error(calendarError(error)); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!item || busy) return;
    setDeleting(true);
    try {
      await props.client.calendarWrite(props.workspaceId, `/${item.id}/delete`, { revision: item.revision });
      toast.success(t("calendar.deleted")); props.onSaved();
    } catch (error) { toast.error(calendarError(error)); } finally { setDeleting(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) props.onClose(); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <form className="contents" onSubmit={event => { event.preventDefault(); void save(); }}>
        <DialogHeader><DialogTitle>{t(item ? "calendar.edit" : "calendar.add")}</DialogTitle><DialogDescription>{t("calendar.manual_hint")}</DialogDescription></DialogHeader>
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5"><Label htmlFor={ids.title}>{t("calendar.name")}</Label><Input id={ids.title} autoFocus required maxLength={1000} placeholder={t("calendar.title_placeholder")} value={title} onChange={event => setTitle(event.target.value)} /></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor={ids.description}>{t("tasks.field_description")}</Label><Textarea id={ids.description} rows={3} maxLength={20000} placeholder={t("calendar.description_placeholder")} value={description} onChange={event => setDescription(event.target.value)} /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5"><Label htmlFor={ids.day}>{t("calendar.day")}</Label><Input id={ids.day} type="date" required disabled={advanced} value={day} onChange={event => setDay(event.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor={ids.reminder}>{t("calendar.reminder")}</Label><Select value={reminder} items={reminderItems} onValueChange={value => { if (value) setReminder(value); }}><SelectTrigger id={ids.reminder} className="w-full"><Bell className="size-4 text-muted-foreground" /><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{reminderItems.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div>
          </div>
          {advanced && <p className="text-xs leading-5 text-muted-foreground">{t("calendar.advanced_hint")}</p>}
          {(members.data?.length || item?.assigneeUserId) ? <div className="flex flex-col gap-1.5"><Label htmlFor={ids.assignee}>{t("calendar.assignee")}</Label>
            <Select value={assignee} items={assigneeItems} onValueChange={value => setAssignee(value ?? UNASSIGNED)}><SelectTrigger id={ids.assignee} className="w-full"><AssigneeMark name={assignee === UNASSIGNED ? null : chosenAssignee?.primary ?? null} /><SelectValue /></SelectTrigger><SelectContent className="w-auto min-w-(--anchor-width) max-w-80"><SelectGroup>{assigneeItems.map(option => <SelectItem key={option.value} value={option.value}><AssigneeMark name={option.value === UNASSIGNED ? null : option.primary} /><OptionText primary={option.primary} detail={option.detail} /></SelectItem>)}</SelectGroup></SelectContent></Select>
          </div> : null}
          {item && <div className="grid items-center gap-4 sm:grid-cols-2"><div className="flex flex-col gap-1.5"><Label htmlFor={ids.status}>{t("calendar.status")}</Label><Select value={status} items={statusItems} onValueChange={value => { if (value === "active" || value === "completed" || value === "cancelled") setStatus(value); }}><SelectTrigger id={ids.status} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{statusItems.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div><div className="flex items-center gap-2 sm:pt-5"><Checkbox id={ids.reviewed} checked={verified} onCheckedChange={setVerified} /><Label htmlFor={ids.reviewed}>{t("calendar.verified")}</Label></div></div>}
          <Collapsible className="border-t border-border/60 pt-1">
            <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-8 justify-start gap-2 px-0 text-xs font-normal text-muted-foreground" />}><ChevronRight className="size-3.5" />{t("calendar.more_details")}</CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pb-1 pt-3">
              {(!item || item.provenance.kind === "manual") && <div className="flex flex-col gap-1.5"><Label htmlFor={ids.source}>{t("calendar.source")}</Label><Input id={ids.source} maxLength={4000} placeholder={t("calendar.source_placeholder")} value={source} onChange={event => setSource(event.target.value)} /></div>}
              <div className="flex flex-col gap-1.5"><Label htmlFor={ids.timeZone}>{t("calendar.timezone")}</Label><Input id={ids.timeZone} required disabled={advanced} value={timeZone} onChange={event => setTimeZone(event.target.value)} /></div>
            </CollapsibleContent>
          </Collapsible>
          {needsReason && <div className="flex flex-col gap-1.5"><Label htmlFor={ids.reason}>{t("calendar.override_reason")}</Label><Textarea id={ids.reason} required maxLength={4000} rows={2} value={reason} onChange={event => setReason(event.target.value)} /></div>}
          {item && <CalculationDetails item={item} />}
        </fieldset>
        <DialogFooter>
          {item && <Button type="button" variant="ghost" className="sm:mr-auto" disabled={busy} onClick={() => void remove()}>{deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}{t("calendar.delete")}</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !title.trim() || !day || (needsReason && !reason.trim())} aria-busy={saving}>{saving && <Loader2 className="animate-spin" />}{t(item ? "calendar.save" : "calendar.add")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
