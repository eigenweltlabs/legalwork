import { createHash, randomUUID } from "node:crypto";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import type { CaptureProposal, CaptureSettings } from "@legalwork/types/time-capture";
import { dayInZone, zonedInstant } from "../calendar/dates.js";

export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export type WorkdayEvidence = { eventKey: string; proposal: CaptureProposal };

export function workdayEvidence(
  events: CalendarOccurrence[],
  day: string,
  settings: CaptureSettings,
): WorkdayEvidence[] {
  const seen = new Set<string>();
  return events.flatMap((event) => {
    const source = event.kind === "task" ? "tasks" : "calendar";
    if (!settings[source] || !["event", "task"].includes(event.kind) || event.status === "cancelled")
      return [];
    if (source === "tasks" && !["done", "completed"].includes(event.status)) return [];
    const startAt = event.allDay ? null : zonedInstant(event.start, event.timeZone);
    const date = startAt ? dayInZone(startAt, event.timeZone) : event.start.slice(0, 10);
    if (date !== day) return [];
    const endAt = !event.allDay && event.end ? zonedInstant(event.end, event.timeZone) : null;
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
