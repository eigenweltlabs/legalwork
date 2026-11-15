import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  stopwatchStateSchema,
  type CaptureProposal,
  type StopwatchAction,
} from "../back-office/timesheet-schema.js";
import { dayInZone } from "../calendar/dates.js";
import { ApiError } from "../errors.js";
import { proposalCommitment } from "./original.js";
import type { WorkdayEvidence } from "./private-workday.js";

export const privateStopwatchSchema = z.object({
  active: stopwatchStateSchema.shape.active.unwrap().extend({ zone: z.string() }).nullable(),
  lastStopped: stopwatchStateSchema.shape.lastStopped,
  stoppedIds: z.array(z.uuid()),
});
export const emptyStopwatch = () => ({ active: null, lastStopped: null, stoppedIds: [] });
type SavedStopwatch = {
  stopwatch: z.infer<typeof privateStopwatchSchema>;
  days: Record<string, WorkdayEvidence[]>;
  originals: Record<string, CaptureProposal>;
};

function daySegments(start: number, end: number, zone: string) {
  const spans = [];
  const day = (time: number) => dayInZone(new Date(time).toISOString(), zone);
  let cursor = start;
  do {
    const date = day(cursor);
    // A fall-back day can contain 25 hours. Workday entries support at most 1440 minutes each.
    let until = Math.min(end, cursor + 1440 * 60_000);
    if (until > cursor && day(until - 1) !== date) {
      // Find the actual change of local date, including zones whose clocks skip midnight.
      let lo = cursor + 1,
        hi = until;
      while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (day(mid) === date) lo = mid + 1;
        else hi = mid;
      }
      until = lo;
    }
    spans.push({ date, start: cursor, end: until });
    cursor = until;
  } while (cursor < end);
  return spans;
}

/** Mutate one private profile while its write lock is held. Each run ID has one start and one stop. */
export function changeStopwatch(
  saved: SavedStopwatch,
  action: StopwatchAction,
  now: Date,
  zone: string,
) {
  const timer = saved.stopwatch;
  if (timer.stoppedIds.includes(action.id)) return;
  if (action.type === "start") {
    if (timer.active?.id === action.id) return;
    if (timer.active) throw new ApiError(409, "stopwatch_running", "A stopwatch is already running.");
    timer.active = { id: action.id, startedAt: now.toISOString(), zone };
    return;
  }
  if (timer.active?.id !== action.id)
    throw new ApiError(409, "stopwatch_changed", "This stopwatch is no longer running.");
  const start = Date.parse(timer.active.startedAt);
  const end = now.getTime();
  if (end < start)
    throw new ApiError(
      409,
      "stopwatch_clock",
      "The system clock is earlier than the stopwatch start. Check the device time.",
    );
  const spans = daySegments(start, end, timer.active.zone);
  for (const span of spans) {
    const minutes = Math.round((span.end - span.start) / 60_000);
    const proposal: CaptureProposal = {
      key: randomUUID(),
      date: span.date,
      digest: "",
      source: "stopwatch",
      projectId: null,
      narrative: "Stopwatch",
      activity: "",
      dismissed: false,
      workedMinutes: minutes || null,
      startAt: new Date(span.start).toISOString(),
      endAt: new Date(span.end).toISOString(),
    };
    proposal.digest = proposalCommitment(proposal);
    saved.originals[proposal.digest] = proposal;
    (saved.days[span.date] ??= []).push({ eventKey: `stopwatch/${action.id}/${span.start}`, proposal });
  }
  timer.lastStopped = {
    id: action.id,
    stoppedAt: now.toISOString(),
    date: spans[spans.length - 1].date,
  };
  timer.stoppedIds.push(action.id);
  timer.active = null;
}
