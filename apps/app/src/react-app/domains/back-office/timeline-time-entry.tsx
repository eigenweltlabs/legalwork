import { useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TimeEntryInput, useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration } from "./time-duration";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { draftRules, workdayBillableMinutes, type WorkdayGuideline } from "@legalwork/types/time-capture";
import { soleMatterClient, type TimeDraft, type TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { calendarDay, formatCalendarDay, shiftDay } from "../calendar/calendar-format";
import type { CalendarDisplayOccurrence } from "../calendar/connected-calendars";
import { activityOptions } from "./timesheet-labels";
import { TimeRecordPicker, TimeSelect } from "./time-settings-controls";
import { billableRoundingChoices } from "./time-record-values";

export type SaveTimelineEntry = (requestId: string, entry: TimeDraft) => Promise<void>;
export type TimelineBooking = { key: string; matterId: string; narrative: string; startAt?: string; endAt?: string };
export type TimelineEntrySeed = { date: string; narrative: string; matterId?: string; projectId?: string; startAt?: string; endAt?: string };
export function rangeInstant(date: string, minute: number) {
  const start = new Date(date + "T00:00:00");
  start.setHours(0, minute, 0, 0);
  return start.toISOString();
}

export function appointmentSeed(item: CalendarDisplayOccurrence, date: string, state: Pick<TimesheetState, "projects">): TimelineEntrySeed {
  const project = state.projects.find(project => project.id === item.projectId);
  const seed = { date, narrative: item.title, projectId: project?.id, matterId: project?.matterIds.length === 1 ? project.matterIds[0] : undefined };
  if (item.allDay || !item.end) return seed;
  const start = Math.max(Date.parse(item.start), Date.parse(rangeInstant(date, 0)));
  const end = Math.min(Date.parse(item.end), Date.parse(rangeInstant(date, 1440)));
  return start < end ? { ...seed, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() } : seed;
}

// Both booking services accept a UUID. Each person's occurrence on a service day has one conversion key.
export async function appointmentBookingId(user: string, occurrence: string, date: string) {
  const key = JSON.stringify(["timekeeping/calendar", user, occurrence, date]);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
function clockValue(instant?: string) {
  if (!instant) return "";
  const d = new Date(instant);
  return [d.getHours(), d.getMinutes()].map(n => String(n).padStart(2, "0")).join(":");
}
function clockInstant(date: string, value: string, original?: string) {
  if (original && value === clockValue(original)) return original;
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  const d = new Date(date + "T" + value + ":00");
  if (Number.isFinite(d.getTime()) && clockValue(d.toISOString()) === value) return d.toISOString();
}

export function TimelineEntryDialog({ seed, requestId, container, trigger, state, guidelines, onSave, onClose }: {
  seed: TimelineEntrySeed; requestId: string; container: HTMLElement; trigger: HTMLElement; state: TimesheetState;
  guidelines: WorkdayGuideline[]; onSave: SaveTimelineEntry; onClose: () => void;
}) {
  const [matterId, setMatter] = useState(seed.matterId ?? "");
  const [narrative, setNarrative] = useState(seed.narrative);
  const [billable, setBillable] = useState(true);
  const [activity, setActivity] = useState("Other");
  const [rounding, setRounding] = useState<{ worked: number; matterId: string; activity: string; amount: number }>();
  const [start, setStart] = useState(clockValue(seed.startAt)), [end, setEnd] = useState(clockValue(seed.endAt));
  const [minutes, setMinutes] = useState("");
  const [attempted, setAttempted] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const savingRef = useRef(false);
  const durationFormat = useTimeDurationFormat();
  const matter = state.matters.find(m => m.id === matterId);
  const projectId = state.projects.find(p => p.id === seed.projectId && p.matterIds.includes(matterId))?.id;
  const clientId = soleMatterClient(matter, state.clients);
  const timed = Boolean(seed.startAt && seed.endAt);
  const startAt = timed ? clockInstant(seed.date, start, seed.startAt) : undefined;
  const midnightEnd = end === "00:00" && start !== "00:00";
  const endDay = midnightEnd ? calendarDay(shiftDay(new Date(seed.date + "T12:00:00"), 1)) : seed.date;
  const endAt = timed ? clockInstant(endDay, end, seed.endAt) : undefined;
  const worked = timed ? (startAt && endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000) : 0) : Number(minutes);
  const durationValid = Number.isInteger(worked) && worked > 0 && worked <= 1440;
  const rules = matter && draftRules(state, guidelines, matter, seed.date, projectId, clientId);
  const defaultCharge = rules && durationValid ? workdayBillableMinutes(worked, rules, activity) : undefined;
  const choices = billable && rules && durationValid && defaultCharge === undefined ? billableRoundingChoices(worked, rules, activity) : [];
  const selectedCharge = rounding?.worked === worked && rounding.matterId === matterId && rounding.activity === activity &&
    choices.includes(rounding.amount) ? rounding.amount : undefined;
  const charge = !billable ? 0 : defaultCharge ?? selectedCharge;
  const workflow = state.service !== "records";
  const fieldError = (show: boolean, message: string) => attempted && show && <small className="text-xs text-destructive" role="alert">{message}</small>;
  return <Dialog open modal={false} onOpenChange={(open, details) => {
    if (open || savingRef.current || details.reason === "focus-out") return;
    if ((details.reason === "escape-key" || details.reason === "outside-press") &&
      (!(details.event.target instanceof Node) || !container.contains(details.event.target))) return;
    onClose();
  }}>
    <DialogContent container={container} finalFocus={() => trigger.isConnected ? trigger : container}
      className="max-h-[calc(100%-1rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>{t("timeWorkspace.createTimeEntry")}</DialogTitle>
        <DialogDescription>{formatCalendarDay(seed.date, { dateStyle: "full" })}</DialogDescription></DialogHeader>
      <form noValidate className="grid min-w-0 gap-4" onSubmit={async event => {
        event.preventDefault();
        setAttempted(true);
        if (!matter || !narrative.trim() || !durationValid || charge === undefined || savingRef.current) return;
        savingRef.current = true; setSaving(true); setError("");
        try {
          await onSave(requestId, { date: seed.date, matterId, clientId, projectId, narrative: narrative.trim(),
            activity, workedMinutes: worked, billable: charge > 0, billableMinutes: charge, startAt, endAt });
          onClose();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : t("timesheets.ledger.failed"));
        } finally { savingRef.current = false; setSaving(false); }
      }}>
      <fieldset disabled={saving} className="grid min-w-0 gap-3 text-sm">
        <label className="grid gap-1">{t("timesheets.workday.description")}
          <Textarea aria-label={t("timesheets.workday.description")} aria-invalid={attempted && !narrative.trim()} value={narrative} maxLength={2000} rows={2} onChange={e => setNarrative(e.target.value)} />
          {fieldError(!narrative.trim(), t("timeWorkspace.requireDescription"))}</label>
        <div className="grid gap-1"><span>{t("timesheets.workday.matter")}</span>
          <TimeRecordPicker label={t("timesheets.workday.matter")} value={matterId} options={state.matters} disabled={saving}
            placeholder={t("timesheets.workday.choose")} onChange={setMatter} />
          {fieldError(!matter, t("timeWorkspace.requireMatter"))}</div>
        {workflow && <div className="grid gap-1"><span>{t("timeWorkspace.optionalActivity")}</span>
          <TimeSelect modal={false} label={t("timeWorkspace.optionalActivity")} value={activity} disabled={saving}
            options={activityOptions({ Other: t("back_office.option.other"), ...rules?.activityLabels }, activity)} onChange={setActivity} />
        </div>}
        {timed ? <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <label className="grid gap-1">{t("timesheets.workday.start")}<Input aria-label={t("timesheets.workday.start")} type="time" value={start} onChange={e => setStart(e.target.value)} /></label>
          <label className="grid gap-1">{t("timesheets.workday.end")}<Input aria-label={t("timesheets.workday.end")} aria-invalid={attempted && !durationValid} type="time" value={end} onChange={e => setEnd(e.target.value)} />
            {fieldError(!durationValid, t("timesheets.workday.invalid"))}</label>
        </div> : <label className="grid gap-1">{t("timesheets.workday.worked")}
          <TimeEntryInput aria-label={t("timesheets.workday.worked")} aria-invalid={attempted && !durationValid} value={minutes} onValueChange={setMinutes} />
          {fieldError(!durationValid, t("timesheets.ledger.valid_worked"))}</label>}
        <label className="flex items-center gap-2"><Checkbox checked={billable} onCheckedChange={setBillable} />{t("timesheets.ledger.change.billable")}</label>
        {choices.length > 0 && rules && <div role="group" aria-label={t("timesheets.ledger.billable")} className="flex flex-wrap items-center gap-2">
          <small>{t("timeWorkspace.chooseBillableIncrement", { minutes: rules.incrementMinutes })}</small>
          {choices.map(amount => <Button key={amount} type="button" size="xs" variant={selectedCharge === amount ? "default" : "outline"}
            aria-pressed={selectedCharge === amount} onClick={() => setRounding({ worked, matterId, activity, amount })}>
            {formatTimeDuration(amount, durationFormat)}
          </Button>)}
        </div>}
        {durationValid && charge !== undefined && <p className="text-xs text-muted-foreground">{t("timeWorkspace.entryMinutes", { worked, charge })}</p>}
        {fieldError(Boolean(matter) && durationValid && charge === undefined,
          t(choices.length ? "timeWorkspace.chooseBillable" : "timeWorkspace.noBillableAmount"))}
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={saving}>{t(saving ? "projects.saving" : "timeWorkspace.createTimeEntry")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
