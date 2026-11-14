import { createHash, randomUUID } from "node:crypto";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import type { CaptureProposal, CaptureSettings } from "@legalwork/types/time-capture";
import { addDays, dayInZone, zonedInstant } from "../calendar/dates.js";

export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export type WorkdayEvidence = { eventKey: string; proposal: CaptureProposal };

export function workdayEvidence(
  events: CalendarOccurrence[],
  day: string,
  settings: CaptureSettings,
  userId?: string,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): WorkdayEvidence[] {
  const seen = new Set<string>();
  const first = zonedInstant(day, zone),
    last = zonedInstant(addDays(day, 1), zone);
  return events.flatMap((event) => {
    const source = event.kind === "task" ? "tasks" : "calendar";
    if (!settings[source] || !["event", "task"].includes(event.kind) || event.status === "cancelled")
      return [];
    if (source === "tasks" && !["done", "completed"].includes(event.status)) return [];
    if (event.assigneeUserId && event.assigneeUserId !== userId) return [];
    let startAt = event.allDay ? null : zonedInstant(event.start, event.timeZone);
    let endAt = !event.allDay && event.end ? zonedInstant(event.end, event.timeZone) : null;
    if (startAt && endAt && endAt > startAt) {
      if (endAt <= first || startAt >= last) return [];
      if (startAt < first) startAt = first;
      if (endAt > last) endAt = last;
    } else if (
      startAt
        ? dayInZone(startAt, zone) !== day
        : event.start > day || (event.end ? event.end <= day : event.start !== day)
    )
      return [];
    const date = day;
    const minutes = startAt && endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000) : 0;
    const eventKey =
      source === "calendar" && event.uid
        ? digest(["meeting", event.uid.toLowerCase(), startAt ?? date])
        : digest([source, event.uid || event.itemId, event.recurring ? event.start : day]);
    if (seen.has(eventKey)) return [];
    seen.add(eventKey);
    const body = {
      date,
      source,
      projectId: event.projectId,
      activity: source === "calendar" ? "EXM" : "RES",
      narrative: event.title.slice(0, 2000),
      startAt,
      endAt,
      workedMinutes: minutes > 0 && minutes <= 1440 ? minutes : null,
    };
    return [
      {
        eventKey,
        proposal: { ...body, source, key: randomUUID(), digest: digest(body), dismissed: false },
      },
    ];
  });
}
