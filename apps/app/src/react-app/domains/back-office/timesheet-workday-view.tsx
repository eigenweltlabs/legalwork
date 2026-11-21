import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "twenty-ui/primitives/input";
import { captureChargeMinutes, type CaptureProposal, type WorkdayCorrection } from "@legalwork/types/time-capture";
import {
  proposedCharge,
  proposedStopwatchCharge,
  resolveTimePolicy,
  timeActivities,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { CalendarGrid } from "../calendar/calendar-grid";
import type { CalendarDisplayOccurrence } from "../calendar/connected-calendars";
import type { TimelineView } from "./time-workspace-panels";
import { sourceKeys } from "./timesheet-labels";
import { isUntitledStopwatch } from "./time-record-values";
import { TimeProposalActions, type ProposalDecision } from "./time-proposal-actions";

type Directory = Pick<TimesheetState, "matters" | "projects" | "policies">;
function matterFor(p: CaptureProposal, state: Directory) {
  if (p.matterId) return state.matters.find((m) => m.id === p.matterId);
  const linked = state.projects.find((project) => project.id === p.projectId)?.matterIds;
  return linked?.length === 1 ? state.matters.find((m) => m.id === linked[0]) : undefined;
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
export function overlappingWorkdayRanges(proposals: readonly CaptureProposal[], booked: readonly WorkdayRange[]) {
  const overlaps = new Set<string>();
  for (const proposal of proposals) {
    const range = interval(proposal);
    if (!range) continue;
    const collide = (item: WorkdayRange) => {
      const other = interval(item);
      return other && other.start < range.end && other.end > range.start;
    };
    if (proposals.some((other) => other.key !== proposal.key && collide(other)) || booked.some(collide))
      overlaps.add(proposal.key);
  }
  return overlaps;
}
export function proposalTitle(proposal: CaptureProposal) {
  return isUntitledStopwatch(proposal)
    ? t("timesheets.source.stopwatch") : proposal.narrative;
}

export function WorkdayTimeline({
  date, proposals, state, view, selected, editorId, preamble, onOpen, decisions,
}: {
  date: string;
  proposals: CaptureProposal[];
  state: Directory;
  view: TimelineView;
  selected: string | undefined;
  editorId?: string;
  preamble?: ReactNode;
  onOpen: (p: CaptureProposal, trigger: HTMLButtonElement) => void;
  decisions?: {
    canAccept: boolean;
    busyKey?: string;
    onDecision: (proposal: CaptureProposal, action: ProposalDecision, trigger: HTMLButtonElement) => void;
    onFocusedRemoval: (proposal: CaptureProposal, container: HTMLDivElement) => void;
  };
}) {
  const anchor = useMemo(() => new Date(date + "T12:00:00"), [date]);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const unassigned = t("timesheets.workday.unassigned");
  const groups = new Map<string | null, { id: string; title: string; colorKey: string | null; items: CalendarDisplayOccurrence[] }>([
    [null, { id: "unassigned", title: unassigned, colorKey: null, items: [] }],
  ]);
  const items: CalendarDisplayOccurrence[] = [];
  const privateById = new Map<string, { proposal: CaptureProposal; matterId: string | null }>();
  for (const proposal of proposals) {
    if (proposal.date !== date) continue;
    const matter = matterFor(proposal, state);
    const matterId = matter?.id ?? null;
    const span = interval(proposal);
    const item: CalendarDisplayOccurrence = {
      id: proposal.key, itemId: proposal.key, uid: proposal.key,
      projectId: proposal.projectId, projectName: matter?.name ?? unassigned,
      kind: "event", title: proposalTitle(proposal),
      start: span ? new Date(span.start).toISOString() : date,
      end: span ? new Date(span.end).toISOString() : null,
      allDay: !span, timeZone, status: "active", assigneeUserId: null,
      provenance: null, verified: true, recurring: false,
    };
    items.push(item);
    privateById.set(item.id, { proposal, matterId });
    if (view === "matters") {
      const lane = groups.get(matterId) ?? { id: "matter-" + matterId, title: item.projectName, colorKey: matterId, items: [] };
      lane.items.push(item);
      groups.set(matterId, lane);
    }
  }
  return <CalendarGrid view="day" anchor={anchor} start={anchor} timeZone={timeZone} items={items} showProjects={false}
    dayLanes={view === "matters" ? [...groups.values()] : undefined} preamble={preamble}
    minimumEventSize={decisions ? { width: 92, height: 28 } : undefined}
    label={t("timesheets.workday.timeline")} untimedLabel={t("timeWorkspace.untimed")}
    nowLabel={time => t("timeWorkspace.now", { time })}
    entryAppearance={item => {
      const source = privateById.get(item.id);
      if (!source) return;
      return {
        colorKey: source.matterId,
        secondaryLabel: item.allDay ? [
          item.projectName,
          t(sourceKeys[source.proposal.source]),
          source.proposal.workedMinutes === null ? undefined : source.proposal.workedMinutes + " min",
        ].filter(Boolean).join(" · ") : item.projectName,
        buttonAttributes: {
          "data-proposal-id": item.id,
          "aria-expanded": selected === item.id,
          "aria-controls": selected === item.id ? editorId : undefined,
        },
        actions: decisions ? <TimelineProposalActions proposal={source.proposal} {...decisions} /> : undefined,
      };
    }}
    onOpen={(item, trigger) => {
      const source = privateById.get(item.id);
      if (source) onOpen(source.proposal, trigger);
    }} />;
}

function TimelineProposalActions({ proposal, canAccept, busyKey, onDecision, onFocusedRemoval }: {
  proposal: CaptureProposal;
  canAccept: boolean;
  busyKey?: string;
  onDecision: (proposal: CaptureProposal, action: ProposalDecision, trigger: HTMLButtonElement) => void;
  onFocusedRemoval: (proposal: CaptureProposal, container: HTMLDivElement) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const remove = useRef({ proposal, onFocusedRemoval });
  remove.current = { proposal, onFocusedRemoval };
  const bindRail = useCallback((element: HTMLDivElement | null) => {
    if (!element && rail.current?.contains(document.activeElement)) remove.current.onFocusedRemoval(remove.current.proposal, rail.current);
    rail.current = element;
  }, []);
  return <TimeProposalActions railRef={bindRail} label={proposalTitle(proposal)} canAccept={canAccept} busy={busyKey === proposal.key}
    onAccept={event => onDecision(proposal, "accept", event.currentTarget)}
    onDismiss={event => onDecision(proposal, "dismiss", event.currentTarget)} />;
}

export function WorkdayCorrectionForm({
  proposal: p,
  state,
  pending,
  save,
  close,
}: {
  proposal: CaptureProposal;
  state: Directory;
  pending: boolean;
  save: (action: WorkdayCorrection) => Promise<boolean>;
  close: () => void;
}) {
  const activityId = useId();
  const [activity, setActivity] = useState(p.activity);
  const [narrative, setNarrative] = useState(p.narrative),
    [start, setStart] = useState(localClock(p.startAt)),
    [end, setEnd] = useState(localClock(p.endAt)),
    [actual, setActual] = useState(p.workedMinutes?.toString() ?? ""),
    [matter, setMatter] = useState(matterFor(p, state)?.id ?? ""),
    [split, setSplit] = useState(false),
    [minutes, setMinutes] = useState("12"),
    [target, setTarget] = useState(""),
    [error, setError] = useState("");
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
    const project = state.projects.find((x) => x.id === p.projectId && x.matterIds.includes(id));
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
    if (m.clientIds.length !== 1) return t("timesheets.workday.choose_client_preview", { minutes });
    const policy = resolveTimePolicy(state.policies, m.clientIds[0], id, p.date, project);
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
  const options = state.matters.map((m) => (
    <option key={m.id} value={m.id}>
      {m.name}
      {m.reference ? " · " + m.reference : ""}
    </option>
  ));
  return (
    <form
      className="bo-workday-correction"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (
          ((start || end) && (!startAt || !endAt)) ||
          (total !== null && !shortStopwatch && (!Number.isInteger(total) || total < 1 || total > 1440)) ||
          (elapsed !== null && elapsed <= 0) ||
          !narrative.trim()
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
            narrative,
            activity: activity.trim() || null,
            ...sourceMatch,
            startAt,
            endAt,
            workedMinutes: shortStopwatch ? null : total,
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
      <label>
        {t("timesheets.workday.matter")}
        <select value={matter} onChange={(e) => setMatter(e.target.value)}>
          <option value="">{t("timesheets.workday.unassigned")}</option>
          {options}
        </select>
      </label>
      <label>
        {t("timesheets.workday.start")}
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label>
        {t("timesheets.workday.end")}
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <label>
        {t("timesheets.workday.worked")}
        <input
          type="number"
          min="1"
          max="1440"
          disabled={!!start || !!end}
          value={start && end ? String(total ?? "") : actual}
          onChange={(e) => setActual(e.target.value)}
        />
      </label>
      <label>
        {t("timesheets.ledger.activity")}
        <input value={activity} maxLength={100} list={activityId} onChange={event => setActivity(event.currentTarget.value)} />
        <datalist id={activityId}>
          {Object.keys({ ...timeActivities, ...activityLabels }).map(code => <option key={code} value={code} />)}
        </datalist>
      </label>
      <label className="bo-workday-narrative">
        {t("timesheets.workday.description")}
        <input value={narrative} maxLength={2000} onChange={(e) => setNarrative(e.target.value)} />
      </label>
      <label className="bo-workday-split">
        <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
        {t("timesheets.workday.split")}
      </label>
      {split && (
        <>
          <label>
            {t("timesheets.workday.last_minutes")}
            <input
              type="number"
              min="1"
              max={total ? total - 1 : 1439}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <label>
            {t("timesheets.workday.target")}
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t("timesheets.workday.choose")}</option>
              {options}
            </select>
          </label>
          {total && +minutes > 0 && +minutes < total && target && target !== matter && (
            <p>
              {preview(matter, total - Number(minutes), (chargeMinutes ?? total) - Number(minutes))} / {preview(target, Number(minutes))}
            </p>
          )}
        </>
      )}
      {!split && total !== null && p.source === "stopwatch" && <p>{preview(matter, total, chargeMinutes ?? total)}</p>}
      <p>{t("timesheets.workday.dictation")}</p>
      {error && <p role="alert">{error}</p>}
      <div>
        <Button type="submit" size="sm" disabled={pending} focusableWhenDisabled>
          {t("timesheets.workday.apply")}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={close}>
          {t("timesheets.workday.cancel")}
        </Button>
      </div>
    </form>
  );
}
