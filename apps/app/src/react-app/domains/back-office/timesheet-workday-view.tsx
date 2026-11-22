import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ItemDescriptionInput } from "@/react-app/design-system/item-detail";
import { DialogFooter } from "@/components/ui/dialog";
import { TimeSelect } from "./time-settings-controls";
import { captureChargeMinutes, type CaptureProposal, type CaptureState, type WorkdayCorrection } from "@legalwork/types/time-capture";
import {
  proposedCharge,
  proposedStopwatchCharge,
  resolveTimePolicy,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { ConnectedCalendarEventDialog } from "../calendar/connected-calendar-event-dialog";
import { CalendarGrid } from "../calendar/calendar-grid";
import type { CalendarDisplayOccurrence } from "../calendar/connected-calendars";
import type { TimelineView } from "./time-workspace-panels";
import { activityOptions, sourceKeys } from "./timesheet-labels";
import { isUntitledStopwatch } from "./time-record-values";
import { TimeProposalActions, type ProposalDecision } from "./time-proposal-actions";
import { matchMatter, matterOptions } from "./timesheet-row";

type Directory = Pick<TimesheetState, "matters" | "projects" | "policies">;
type TimelineDirectory = Directory & Pick<TimesheetState, "clients" | "service">;
function matterFor(p: CaptureProposal, state: Directory) {
  const linked = p.source === "stopwatch" ? undefined : state.projects.find((project) => project.id === p.projectId)?.matterIds;
  return state.matters.find(matter => matter.id === p.matterId) ??
    (linked?.length === 1 ? state.matters.find(matter => matter.id === linked[0]) : undefined);
}
const clock = (minutes: number) =>
  String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
const localClock = (iso: string | null) =>
  iso ? clock(new Date(iso).getHours() * 60 + new Date(iso).getMinutes()) : "";
type WorkdayRange = { startAt?: string | null; endAt?: string | null };
function interval({ startAt, endAt }: WorkdayRange) {
  if (!startAt || !endAt) return undefined;
  const start = Date.parse(startAt), end = Date.parse(endAt);
  return start < end ? { start, end } : undefined;
}
export function proposalTitle(proposal: CaptureProposal) {
  return isUntitledStopwatch(proposal)
    ? t("timesheets.source.stopwatch") : proposal.narrative;
}

export function workdayProposalDisplay(proposal: CaptureProposal, state: TimelineDirectory,
  draft?: CaptureState["drafts"][string], choices?: ReturnType<typeof matterOptions>) {
  let matter = matterFor(proposal, state);
  let narrative: string | undefined;
  if (draft?.proposalDigest === proposal.digest && draft.date === proposal.date) {
    const values = draft.values;
    if (state.service === "records") {
      if (typeof values.matter === "string" || values.matter === null) matter = state.matters.find(item => item.id === values.matter);
      if (typeof values.billingNarrative === "string" || values.billingNarrative === null) narrative = values.billingNarrative ?? "";
    } else if (values.workflow) {
      if (typeof values.matter === "string") {
        const assigned = matchMatter(choices ?? matterOptions(state), values.matter);
        matter = state.matters.find(item => item.id === assigned?.matterId);
      }
      if (typeof values.narrative === "string") narrative = values.narrative;
    }
  }
  const title = narrative?.trim() || (narrative === undefined || isUntitledStopwatch(proposal) ? proposalTitle(proposal) : t("back_office.untitled"));
  return { matter, title };
}

export function WorkdayTimeline({
  date, proposals, appointments = [], previews = [], drafts, state, view, selected, editorId, headerActions, renderTimeOverlay, onOpen, decisions,
}: {
  date: string;
  proposals: CaptureProposal[];
  previews?: CaptureProposal[];
  appointments?: CalendarDisplayOccurrence[];
  drafts?: CaptureState["drafts"];
  state: TimelineDirectory;
  view: TimelineView;
  selected: string | undefined;
  editorId?: string;
  headerActions?: ReactNode;
  renderTimeOverlay?: (now: Date, hourHeight: number) => ReactNode;
  onOpen: (p: CaptureProposal, trigger: HTMLButtonElement) => void;
  decisions?: {
    canAccept: boolean;
    busyKey?: string;
    onDecision: (proposal: CaptureProposal, action: ProposalDecision, trigger: HTMLButtonElement) => void;
    onFocusedRemoval: (proposal: CaptureProposal, element: HTMLElement) => void;
  };
}) {
  const anchor = useMemo(() => new Date(date + "T12:00:00"), [date]);
  const choices = useMemo(() => state.service === "records" ? undefined : matterOptions(state), [state]);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const unassigned = t("timesheets.workday.unassigned");
  const groups = new Map<string | null, { id: string; title: string; colorKey: string | null; items: CalendarDisplayOccurrence[] }>();
  const [opened, setOpened] = useState<{ id: string; trigger: HTMLButtonElement; container: HTMLElement }>();
  const selectedAppointment = opened && appointments.find(item => item.id === opened.id && opened.trigger.isConnected);
  const items: CalendarDisplayOccurrence[] = [...appointments];
  const privateById = new Map<string, { proposal: CaptureProposal; matterId: string | null }>();
  const previewKeys = new Set(previews.map(proposal => proposal.key));
  for (const proposal of [...proposals, ...previews]) {
    if (proposal.date !== date) continue;
    const { matter, title } = workdayProposalDisplay(proposal, state, drafts?.[proposal.key], choices);
    const matterId = matter?.id ?? null;
    const span = interval(proposal);
    const item: CalendarDisplayOccurrence = {
      id: proposal.key, itemId: proposal.key, uid: proposal.key,
      projectId: proposal.projectId, projectName: matter?.name ?? unassigned,
      kind: "event", title,
      start: span ? new Date(span.start).toISOString() : date,
      end: span ? new Date(span.end).toISOString() : null,
      allDay: !span, timeZone, status: "active", assigneeUserId: null,
      provenance: null, verified: true, recurring: false,
    };
    items.push(item);
    privateById.set(item.id, { proposal, matterId });
    if (view === "matters") {
      const lane = groups.get(matterId) ?? { id: matterId ? "matter-" + matterId : "unassigned", title: item.projectName, colorKey: matterId, items: [] };
      lane.items.push(item);
      groups.set(matterId, lane);
    }
  }
  const lanes = [...groups.values()];
  if (appointments.length) lanes.unshift({ id: "calendar", title: t("calendar.title"), colorKey: null, items: appointments });
  return <><CalendarGrid view="day" maxVisibleHours={16} anchor={anchor} start={anchor} timeZone={timeZone} items={items} showProjects={false}
    dayLanes={view === "matters" ? lanes : undefined} headerActions={headerActions} renderTimeOverlay={renderTimeOverlay}
    minimumEventSize={decisions ? { width: 92, height: 28 } : undefined}
    label={t("timesheets.workday.timeline")} untimedLabel={t(appointments.some(item => item.allDay) ? "timeWorkspace.allDayAndUntimed" : "timeWorkspace.untimed")}
    nowLabel={time => t("timeWorkspace.now", { time })}
    entryAppearance={item => {
      const source = privateById.get(item.id);
      if (!source) return {
        secondaryLabel: t("calendar.title"),
        buttonAttributes: { "data-workday-appointment": true, "aria-haspopup": "dialog" },
      };
      if (previewKeys.has(item.id)) return {
        colorKey: source.matterId, secondaryLabel: t("timeWorkspace.preview"),
        buttonAttributes: { "aria-disabled": true, "data-suggestion-preview": true },
      };
      return {
        colorKey: source.matterId,
        secondaryLabel: item.allDay ? [
          item.projectName,
          t(sourceKeys[source.proposal.source]),
          source.proposal.estimatedMinutes !== undefined ? t("timeWorkspace.estimatedMinutes", { minutes: source.proposal.estimatedMinutes })
            : source.proposal.workedMinutes === null ? undefined : source.proposal.workedMinutes + " min",
        ].filter(Boolean).join(" · ") : item.projectName,
        buttonAttributes: {
          "data-proposal-id": item.id,
          "aria-expanded": selected === item.id,
          "aria-controls": selected === item.id ? editorId : undefined,
        },
        onFocusedRemoval: decisions ? button => decisions.onFocusedRemoval(source.proposal, button) : undefined,
        actions: decisions ? <TimelineProposalActions proposal={source.proposal} title={item.title} {...decisions} /> : undefined,
      };
    }}
    onOpen={(item, trigger) => {
      const source = privateById.get(item.id);
      if (source) {
        if (!previewKeys.has(item.id)) onOpen(source.proposal, trigger);
        return;
      }
      const container = trigger.closest<HTMLElement>('[data-workspace-tab="timeline"]');
      if (container) setOpened({ id: item.id, trigger, container });
    }} />
    {selectedAppointment && opened && <ConnectedCalendarEventDialog key={opened.id} item={selectedAppointment}
      pane={opened} onClose={() => setOpened(undefined)} />}
  </>;
}

function TimelineProposalActions({ proposal, title, canAccept, busyKey, onDecision, onFocusedRemoval }: {
  proposal: CaptureProposal;
  title: string;
  canAccept: boolean;
  busyKey?: string;
  onDecision: (proposal: CaptureProposal, action: ProposalDecision, trigger: HTMLButtonElement) => void;
  onFocusedRemoval: (proposal: CaptureProposal, element: HTMLElement) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const remove = useRef({ proposal, onFocusedRemoval });
  remove.current = { proposal, onFocusedRemoval };
  const bindRail = useCallback((element: HTMLDivElement | null) => {
    if (!element && rail.current?.contains(document.activeElement)) remove.current.onFocusedRemoval(remove.current.proposal, rail.current);
    rail.current = element;
  }, []);
  return <TimeProposalActions railRef={bindRail} label={title} canAccept={canAccept} busy={busyKey === proposal.key}
    onAccept={event => onDecision(proposal, "accept", event.currentTarget)}
    onDismiss={event => onDecision(proposal, "dismiss", event.currentTarget)} />;
}

export function WorkdayCorrectionForm({
  proposal: p,
  draftRevision,
  state,
  pending,
  save,
  close,
}: {
  proposal: CaptureProposal;
  draftRevision?: number;
  state: Directory;
  pending: boolean;
  save: (action: WorkdayCorrection) => Promise<boolean>;
  close: () => void;
}) {
  const canSplit = p.source !== "stopwatch";
  const originalMatter = matterFor(p, state)?.id ?? "";
  const [activity, setActivity] = useState(p.activity);
  const [narrative, setNarrative] = useState(p.narrative),
    [start, setStart] = useState(localClock(p.startAt)),
    [end, setEnd] = useState(localClock(p.endAt)),
    [actual, setActual] = useState((p.workedMinutes ?? p.estimatedMinutes)?.toString() ?? ""),
    [matter, setMatter] = useState(originalMatter),
    [splitSource, setSplitSource] = useState<string>(),
    [minutes, setMinutes] = useState("12"),
    [target, setTarget] = useState(""),
    [error, setError] = useState("");
  const split = canSplit && splitSource === p.digest;
  function instant(value: string, original: string | null, ending = false) {
    if (!value) return null;
    if (original && localClock(original) === value) return original;
    const day = new Date(p.date + "T" + value + ":00");
    if (ending && value === "00:00" && start > "00:00") day.setDate(day.getDate() + 1);
    if (!Number.isFinite(day.getTime())) return null;
    return localClock(day.toISOString()) === value ? day.toISOString() : null;
  }
  const startAt = instant(start, p.startAt),
    endAt = instant(end, p.endAt, true);
  const elapsed = startAt && endAt ? (Date.parse(endAt) - Date.parse(startAt)) / 60000 : null;
  const total = elapsed === null ? (actual ? Number(actual) : null) : Math.round(elapsed);
  const shortStopwatch = p.source === "stopwatch" && elapsed !== null && elapsed > 0 && total === 0;
  function assignment(id: string) {
    const m = state.matters.find((x) => x.id === id);
    const project = p.source !== "stopwatch" ? state.projects.find((x) => x.id === p.projectId && x.matterIds.includes(id)) : undefined;
    return { matterId: m?.id ?? null, projectId: project?.id ?? null };
  }
  const targetMatch = assignment(target);
  const sourceMatch = assignment(matter);
  const assignedMatter = state.matters.find(item => item.id === sourceMatch.matterId);
  const activityLabels = resolveTimePolicy(state.policies, assignedMatter?.clientIds.length === 1 ? assignedMatter.clientIds[0] : "",
    assignedMatter?.id ?? "", p.date, sourceMatch.projectId ?? undefined).activityLabels;
  const chargeMinutes = captureChargeMinutes({ ...p, startAt, endAt, workedMinutes: total });
  function preview(id: string, minutes: number, measured = minutes) {
    const m = state.matters.find((x) => x.id === id);
    if (!m) return "";
    const project = assignment(id).projectId ?? undefined;
    const policy = resolveTimePolicy(state.policies, m.clientIds.length === 1 ? m.clientIds[0] : "", id, p.date, project);
    if (p.source === "stopwatch")
      return t("timesheets.workday.minutes_rounded", {
        minutes, charge: proposedStopwatchCharge(measured, policy),
      });
    if (!policy.enforceIncrement || minutes % policy.incrementMinutes === 0)
      return t("timesheets.workday.minutes_exact", { minutes });
    if (policy.rounding !== "choose")
      return t("timesheets.workday.minutes_rounded", {
        minutes,
        charge: proposedCharge(minutes, policy),
      });
    return t("timesheets.workday.minutes_choose", {
      minutes,
      lower: Math.floor(minutes / policy.incrementMinutes) * policy.incrementMinutes,
      upper: Math.ceil(minutes / policy.incrementMinutes) * policy.incrementMinutes,
    });
  }
  const options = state.matters.map(({ id, name, reference }) => ({ id, name: reference ? name + " · " + reference : name }));
  return (
    <form data-time-source-editor className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (
          ((start || end) && (!startAt || !endAt)) ||
          (total !== null && !shortStopwatch && (!Number.isInteger(total) || total < 1 || total > 1440)) ||
          (elapsed !== null && elapsed <= 0) ||
          (p.source === "stopwatch" && !sourceMatch.matterId) || !narrative.trim()
        ) {
          setError(t("timesheets.workday.invalid"));
          return;
        }
        if (
          split &&
          (!total ||
            !sourceMatch.matterId ||
            !targetMatch.matterId ||
            target === matter ||
            !Number.isInteger(+minutes) ||
            +minutes <= 0 ||
            +minutes >= total)
        ) {
          setError(t("timesheets.workday.split_invalid"));
          return;
        }
        if (
          await save({
            type: "correct",
            key: p.key,
            digest: p.digest,
            ...(draftRevision === undefined ? {} : { draftRevision }),
            narrative,
            activity: activity.trim() || null,
            ...(p.source !== "stopwatch" && !split && matter === originalMatter ? { matterId: p.matterId ?? null, projectId: p.projectId } : sourceMatch),
            startAt,
            endAt,
            workedMinutes: shortStopwatch || (!split && !startAt && total === p.estimatedMinutes) ? null : total,
            ...(p.estimatedMinutes !== undefined && total === null ? { clearEstimate: true } : {}),
            ...(split && targetMatch.matterId
              ? {
                  split: {
                    minutes: +minutes,
                    matterId: targetMatch.matterId,
                    projectId: targetMatch.projectId,
                  },
                }
              : {}),
          })
        )
          close();
      }}
    >
      <label className="grid gap-1.5 text-sm">{t("timesheets.workday.description")}
        <ItemDescriptionInput className="min-h-16 rounded-lg border bg-background px-3 py-2" value={narrative} required
          maxLength={2000} onChange={event => setNarrative(event.currentTarget.value)} />
      </label>
      <label className="grid gap-1.5 text-sm">{t("timesheets.workday.matter")}
        <TimeSelect label={t("timesheets.workday.matter")} value={matter} onChange={setMatter}
          placeholder={t("timesheets.workday.choose")} options={canSplit ? [{ id: "", name: t("timesheets.workday.unassigned") }, ...options] : options} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1.5 text-sm">{t("timesheets.workday.start")}
          <Input type="time" value={start} onChange={event => setStart(event.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm">{t("timesheets.workday.end")}
          <Input type="time" value={end} onChange={event => setEnd(event.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm">{t("timesheets.workday.worked")}
          <Input type="number" min="1" max="1440" disabled={!!start || !!end}
            value={start && end ? String(total ?? "") : actual} onChange={event => setActual(event.currentTarget.value)} />
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm">{t("timesheets.ledger.activity")}
          <TimeSelect label={t("timesheets.ledger.activity")} value={activity} options={[
            { id: "", name: t("timeWorkspace.noActivity") }, ...activityOptions(activityLabels, activity),
          ]} onChange={setActivity} />
        </label>
      </div>
      {p.estimatedMinutes !== undefined && <p className="text-sm text-muted-foreground">
        {t("timeWorkspace.estimatedMinutes", { minutes: p.estimatedMinutes })}{p.estimateReason ? " · " + p.estimateReason : ""}
      </p>}
      {canSplit && <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={split} onCheckedChange={checked => setSplitSource(checked ? p.digest : undefined)} />
        {t("timesheets.workday.split")}
      </label>}
      {split && <>
        <label className="grid gap-1.5 text-sm">{t("timesheets.workday.last_minutes")}
          <Input type="number" min="1" max={total ? total - 1 : 1439} value={minutes}
            onChange={event => setMinutes(event.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm">{t("timesheets.workday.target")}
          <TimeSelect label={t("timesheets.workday.target")} value={target} options={options}
            placeholder={t("timesheets.workday.choose")} onChange={setTarget} />
        </label>
        {total && +minutes > 0 && +minutes < total && target && target !== matter &&
          <p className="text-sm text-muted-foreground">{preview(matter, total - Number(minutes), (chargeMinutes ?? total) - Number(minutes))} / {preview(target, Number(minutes))}</p>}
      </>}
      {!split && total !== null && p.source === "stopwatch" && <p className="text-sm text-muted-foreground">{preview(matter, total, chargeMinutes ?? total)}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <DialogFooter className="m-0 border-0 bg-transparent p-0">
        <Button type="button" size="sm" variant="ghost" onClick={close}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={pending || (!canSplit && !matter)}>{t("common.save")}</Button>
      </DialogFooter>
    </form>
  );
}
