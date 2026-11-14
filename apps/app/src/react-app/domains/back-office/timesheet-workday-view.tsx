import { useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import type { CaptureProposal, WorkdayCorrection } from "@legalwork/types/time-capture";
import {
  proposedCharge,
  resolveTimePolicy,
  type TimeEntry,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { layoutCalendarDay } from "../calendar/calendar-layout";
import { formatCalendarDay } from "../calendar/calendar-format";

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
export function overlappingWorkdayRanges(proposals: CaptureProposal[], recorded: TimeEntry[]) {
  const overlaps = new Set<string>();
  const booked = recorded.filter((row) =>
    ["confirmed", "submitted", "approved", "invoiced"].includes(row.status),
  );
  for (const proposal of proposals) {
    if (!proposal.startAt || !proposal.endAt) continue;
    const start = Date.parse(proposal.startAt),
      end = Date.parse(proposal.endAt);
    const collide = (item: { startAt?: string | null; endAt?: string | null }) =>
      item.startAt && item.endAt && Date.parse(item.startAt) < end && Date.parse(item.endAt) > start;
    if (proposals.some((other) => other.key !== proposal.key && collide(other)) || booked.some(collide))
      overlaps.add(proposal.key);
  }
  return overlaps;
}
type Block = {
  key: string;
  title: string;
  startAt: string;
  endAt: string;
  matter: string;
  proposal?: CaptureProposal;
};
export function WorkdayTimeline({
  date,
  proposals,
  state,
  confirmed,
  onOpen,
}: {
  date: string;
  proposals: CaptureProposal[];
  state: Directory;
  confirmed: TimeEntry[];
  onOpen: (p: CaptureProposal) => void;
}) {
  const loose = t("timesheets.workday.unassigned");
  const groups = new Map<string, { title: string; blocks: Block[] }>();
  function add(id: string, title: string, block: Block) {
    const group = groups.get(id) ?? { title, blocks: [] };
    group.blocks.push(block);
    groups.set(id, group);
  }
  for (const p of proposals)
    if (p.startAt && p.endAt) {
      const matter = matterFor(p, state),
        title = matter?.name ?? loose;
      add(matter?.id ?? "unassigned", title, {
        key: p.key,
        title: p.narrative,
        startAt: p.startAt,
        endAt: p.endAt,
        matter: title,
        proposal: p,
      });
    }
  const accepted = confirmed.filter(
    (row) =>
      row.date === date && ["confirmed", "submitted", "approved", "invoiced"].includes(row.status),
  );
  for (const entry of accepted)
    if (entry.startAt && entry.endAt) {
      const matter = state.matters.find((m) => m.id === entry.matterId)?.name ?? "";
      add("confirmed", t("timesheets.workday.booked"), {
        key: entry.id,
        title: entry.narrative,
        startAt: entry.startAt,
        endAt: entry.endAt,
        matter,
      });
    }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const columns = [...groups.values()].map(({ title, blocks }) => ({
    title,
    segments: layoutCalendarDay(
      blocks.map(
        (block) =>
          ({
            id: block.key,
            itemId: block.key,
            uid: block.key,
            projectId: null,
            projectName: block.matter,
            kind: "event",
            title: block.title,
            start: block.startAt,
            end: block.endAt,
            allDay: false,
            timeZone: zone,
            status: "active",
            assigneeUserId: null,
            provenance: null,
            verified: true,
            recurring: false,
            block,
          }) satisfies CalendarOccurrence & { block: Block },
      ),
      date,
    ),
  }));
  const all = columns.flatMap((column) => column.segments);
  if (!all.length) return null;
  const low = Math.floor(Math.min(...all.map((s) => s.displayStart)) / 60) * 60,
    high = Math.min(1440, Math.ceil(Math.max(...all.map((s) => s.displayEnd)) / 60) * 60);
  const hours = Array.from({ length: (high - low) / 60 }, (_, i) => low + 60 * i);
  return (
    <div
      className="bo-workday-axis"
      aria-label={t("timesheets.workday.timeline")}
      style={{ gridTemplateColumns: "52px repeat(" + columns.length + ",minmax(125px,1fr))" }}
    >
      <div className="bo-workday-axis-label">{formatCalendarDay(date)}</div>
      {columns.map((column, idx) => (
        <b key={idx} className="bo-workday-axis-heading">
          {column.title}
        </b>
      ))}
      <div className="bo-workday-axis-times">
        {hours.map((hour) => (
          <time key={hour}>{clock(hour)}</time>
        ))}
      </div>
      {columns.map((column, idx) => (
        <div key={idx} className="bo-workday-axis-column" style={{ height: hours.length * 54 }}>
          {column.segments.map((segment) => {
            const b = segment.item.block;
            const style = {
              top: (segment.displayStart - low) * 0.9,
              height: Math.max(18, (segment.displayEnd - segment.displayStart) * 0.9 - 2),
              left: (100 * segment.column) / segment.columns + "%",
              width: (100 * segment.span) / segment.columns + "%",
            };
            const caption = localClock(b.startAt) + "–" + localClock(b.endAt) + " · " + b.title;
            return b.proposal ? (
              <button
                key={b.key}
                type="button"
                className="bo-workday-axis-event"
                style={style}
                title={caption}
                onClick={() => b.proposal && onOpen(b.proposal)}
              >
                {caption}
              </button>
            ) : (
              <div
                key={b.key}
                className="bo-workday-axis-event booked"
                style={style}
                title={caption + " · " + b.matter}
              >
                {caption}
              </div>
            );
          })}
        </div>
      ))}
    </div>
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
    return localClock(day.toISOString()) === value ? day.toISOString() : null;
  }
  const startAt = instant(start, p.startAt),
    endAt = instant(end, p.endAt, true);
  const total =
    startAt && endAt
      ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000)
      : actual
        ? Number(actual)
        : null;
  function assignment(id: string) {
    const m = state.matters.find((x) => x.id === id);
    const project = state.projects.find((x) => x.id === p.projectId && x.matterIds.includes(id));
    return { matterId: m?.id ?? null, projectId: project?.id ?? null };
  }
  const targetMatch = assignment(target);
  const sourceMatch = assignment(matter);
  function preview(id: string, minutes: number) {
    const m = state.matters.find((x) => x.id === id);
    if (!m) return "";
    const project = assignment(id).projectId ?? undefined;
    if (m.clientIds.length !== 1) return t("timesheets.workday.choose_client_preview", { minutes });
    const policy = resolveTimePolicy(state.policies, m.clientIds[0], id, p.date, project);
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
          (total !== null && (!Number.isInteger(total) || total < 1 || total > 1440)) ||
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
            ...sourceMatch,
            startAt,
            endAt,
            workedMinutes: total,
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
              {preview(matter, total - Number(minutes))} / {preview(target, Number(minutes))}
            </p>
          )}
        </>
      )}
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
