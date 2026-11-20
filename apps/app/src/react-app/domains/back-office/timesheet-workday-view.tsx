import { useEffect, useId, useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { captureChargeMinutes, type CaptureProposal, type WorkdayCorrection } from "@legalwork/types/time-capture";
import {
  proposedCharge,
  proposedStopwatchCharge,
  resolveTimePolicy,
  timeActivities,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { layoutCalendarDay } from "../calendar/calendar-layout";
import { calendarDay, formatCalendarDay } from "../calendar/calendar-format";
import type { TimelineView } from "./time-workspace-panels";
import { sourceKeys } from "./timesheet-labels";
import { isUntitledStopwatch } from "./time-record-values";

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

const hourHeight = 54;
const minuteHeight = hourHeight / 60;
function matterTone(matterId: string) {
  if (!matterId) return 0;
  let hash = 0;
  for (const character of matterId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return 1 + Math.abs(hash) % 6;
}

export function WorkdayTimeline({
  date, proposals, state, view, selected, onOpen,
}: {
  date: string;
  proposals: CaptureProposal[];
  state: Directory;
  view: TimelineView;
  selected: string | undefined;
  onOpen: (p: CaptureProposal) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  const nowMinute = calendarDay(now) === date ? now.getHours() * 60 + now.getMinutes() : null;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const loose = t("timesheets.workday.unassigned");
  const day = proposals.filter(proposal => proposal.date === date);
  const byMatter = new Map<string, string>([["", loose]]);
  const untimed: CaptureProposal[] = [];
  const timed = day.flatMap(proposal => {
    const matter = matterFor(proposal, state);
    if (matter) byMatter.set(matter.id, matter.name);
    if (!proposal.startAt || !proposal.endAt || !interval(proposal)) {
      untimed.push(proposal);
      return [];
    }
    return [{
      id: proposal.key, itemId: proposal.key, uid: proposal.key,
      projectId: proposal.projectId, projectName: matter?.name ?? loose,
      kind: "event", title: proposalTitle(proposal),
      start: new Date(proposal.startAt).toISOString(), end: new Date(proposal.endAt).toISOString(),
      allDay: false, timeZone: localZone, status: "active", assigneeUserId: null, provenance: null,
      verified: true, recurring: false, proposal, matterId: matter?.id ?? "",
    } satisfies CalendarOccurrence & { proposal: CaptureProposal; matterId: string }];
  });
  const groups = view === "matters" ? [...byMatter] : [["", ""]];
  const columns = groups.map(([id, title]) => ({
    id, title, segments: layoutCalendarDay(view === "combined" ? timed : timed.filter(item => item.matterId === id), date),
  }));
  const visibleSegments = columns.flatMap(column => column.segments);
  const visibleStart = Math.min(8 * 60, nowMinute ?? 1440, ...visibleSegments.map(segment => segment.displayStart));
  const visibleEnd = Math.max(18 * 60, nowMinute === null ? 0 : nowMinute + 1, ...visibleSegments.map(segment => segment.displayEnd));
  const low = Math.floor(visibleStart / 60) * 60;
  const high = Math.ceil(visibleEnd / 60) * 60;
  const hours = Array.from({ length: (high - low) / 60 }, (_, i) => low + i * 60);
  return (
    <>
      <div
        className="bo-workday-axis"
        aria-label={t("timesheets.workday.timeline")}
        style={{ gridTemplateColumns: "44px repeat(" + columns.length + ",minmax(" + (view === "matters" ? "116px" : "0") + ",1fr))" }}
      >
        <div className="bo-workday-axis-label">{formatCalendarDay(date, { day: "numeric", month: "short" })}</div>
        {columns.map(({ id, title }) => (
          <div key={id} data-tone={matterTone(id)} className="bo-workday-axis-heading">{title}</div>
        ))}
        <div className="bo-workday-axis-times">
          {hours.map(hour => <time key={hour}>{clock(hour)}</time>)}
        </div>
        {columns.map(column => (
          <div key={column.id} className="bo-workday-axis-column" style={{ height: hours.length * hourHeight }}>
            {column.segments.map(segment => {
              const item = segment.item;
              const time = localClock(item.start) + "–" + localClock(item.end);
              return (
                <button
                  key={item.id} type="button" className="bo-workday-axis-event" data-proposal-id={item.id}
                  data-tone={matterTone(item.matterId)} aria-pressed={selected === item.id}
                  data-short={segment.displayEnd - segment.displayStart < 32 || undefined}
                  style={{
                    top: (segment.displayStart - low) * minuteHeight,
                    height: (segment.displayEnd - segment.displayStart) * minuteHeight - 1,
                    left: (100 * segment.column) / segment.columns + "%",
                    width: (100 * segment.span) / segment.columns + "%",
                  }}
                  title={[time, item.title, item.projectName].join(" · ")}
                  aria-label={[time, item.title, item.projectName].join(" · ")}
                  onClick={() => onOpen(item.proposal)}
                >
                  <span>{time} · {item.title}</span>
                  <small>{item.projectName}</small>
                </button>
              );
            })}
            {nowMinute !== null && <div className="bo-workday-now" style={{ top: (nowMinute - low) * minuteHeight }}
              aria-hidden={column !== columns[0] || undefined}>
              {column === columns[0] && <span className="sr-only">{t("timeWorkspace.now", { time: clock(nowMinute) })}</span>}
            </div>}
          </div>
        ))}
      </div>
      {untimed.length > 0 && (
        <section className="bo-workday-untimed" aria-label={t("timeWorkspace.untimed")}>
          <h3>{t("timeWorkspace.untimed")}</h3>
          {untimed.map(proposal => {
            const matter = matterFor(proposal, state);
            return (
              <button type="button" key={proposal.key} data-proposal-id={proposal.key} data-tone={matterTone(matter?.id ?? "")}
                aria-pressed={selected === proposal.key} onClick={() => onOpen(proposal)}>
                <strong>{proposalTitle(proposal)}</strong>
                <small>{matter?.name ?? loose} · {t(sourceKeys[proposal.source])}
                  {proposal.workedMinutes !== null && " · " + proposal.workedMinutes + " min"}</small>
              </button>
            );
          })}
        </section>
      )}
    </>
  );
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
            ...(activity.trim() ? { activity: activity.trim() } : {}),
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
        <Button type="submit" size="sm" disabled={pending}>
          {t("timesheets.workday.apply")}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={close}>
          {t("timesheets.workday.cancel")}
        </Button>
      </div>
    </form>
  );
}
