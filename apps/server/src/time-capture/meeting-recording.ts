import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dayInZone, addDays, zonedInstant } from "../calendar/dates.js";
import { digest, type WorkdayEvidence } from "./private-workday.js";

export const recordingInput = z.strictObject({
  profileId: z.string().length(64), epoch: z.number().int().nonnegative(), id: z.string().regex(/^rec-[a-z0-9]+-[a-z0-9]{1,8}$/),
  title: z.string().trim().min(1).max(240).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  projectId: z.string().min(1).max(200).nullable(),
  startedAt: z.number().int().positive(), stoppedAt: z.number().int().positive(),
}).refine(row => row.stoppedAt > row.startedAt && row.startedAt >= row.epoch && row.stoppedAt <= Date.now());

export function recordingEvidence(input: z.infer<typeof recordingInput>, zone: string): WorkdayEvidence[] {
  const { profileId, id, projectId, title, startedAt, stoppedAt } = input;
  const start = new Date(startedAt).toISOString(), end = new Date(stoppedAt).toISOString();
  const rows: WorkdayEvidence[] = [];
  const first = dayInZone(start, zone);
  let date = first;
  const last = dayInZone(new Date(stoppedAt - 1).toISOString(), zone);
  while (date <= last) {
    const next = addDays(date, 1);
    const startAt = date === first ? start : zonedInstant(date, zone);
    const endAt = date === last ? end : zonedInstant(next, zone);
    const eventKey = digest(["recordings", profileId, id, date]);
    const body = { source: "recordings" as const, date, startAt, endAt, projectId, narrative: title, activity: "EXM", workedMinutes: null };
    rows.push({ eventKey, proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]), dismissed: false } });
    date = next;
  }
  return rows;
}
