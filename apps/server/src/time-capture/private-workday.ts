import { createHash, randomUUID } from "node:crypto";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import type { CaptureProposal, CaptureSettings } from "@legalwork/types/time-capture";
import { captureFileSource, captureProposalSchema } from "../back-office/timesheet-schema.js";
import { z } from "zod";
import { addDays, dayInZone, zonedInstant } from "../calendar/dates.js";

export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export const evidenceClaimSchema = z.object({
  id: z.string(), source: captureProposalSchema.shape.source, account: captureProposalSchema.shape.account,
  from: z.number().nullable(), to: z.number().nullable(), observationStart: z.number().optional(),
});
export const workdayEvidenceSchema = z.object({
  eventKey: z.string(), proposal: captureProposalSchema, claims: z.array(evidenceClaimSchema).optional(),
  generated: z.boolean().optional(), sourceDocumentTitle: z.string().max(500).optional(),
});
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;
export type WorkdayEvidence = z.infer<typeof workdayEvidenceSchema>;

export type Interval = { from: number; to: number };
export function humanInterval(proposal: CaptureProposal): Interval | undefined {
  if (proposal.source === "workspace" && proposal.observation !== "foreground") return;
  if (proposal.source === "agent" || proposal.source === "documents" || captureFileSource(proposal.source) || proposal.source === "tasks" ||
      proposal.source === "gmail" || proposal.source === "outlook" || !proposal.startAt || !proposal.endAt) return;
  const from = Date.parse(proposal.startAt), to = Date.parse(proposal.endAt);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to };
}
export function claimsFor(item: WorkdayEvidence): EvidenceClaim[] {
  if (item.claims) return item.claims;
  const { source, account } = item.proposal;
  const clocks = humanInterval(item.proposal);
  return [{ id: item.eventKey, source, account, from: clocks?.from ?? null, to: clocks?.to ?? null }];
}
export function intervalsOverlap(a: Interval, b: Interval) {
  return a.from < b.to && b.from < a.to;
}
export function claimsOverlap(a: EvidenceClaim, b: EvidenceClaim) {
  return a.id === b.id && (a.source === "stopwatch" || a.from === null || a.to === null ||
    (a.observationStart !== undefined && b.observationStart !== undefined && a.observationStart !== b.observationStart) ||
    b.from === null || b.to === null || intervalsOverlap({ from: a.from, to: a.to }, { from: b.from, to: b.to }));
}

/** A timed calendar appointment is a plan. Only elapsed parts may support a workday suggestion. */
export function elapsedEvidence(rows: WorkdayEvidence[], date: string, zone: string, now: number): WorkdayEvidence[] {
  const today = dayInZone(new Date(now).toISOString(), zone);
  if (date > today) return [];
  if (date < today) return rows;
  return rows.flatMap(item => {
    const p = item.proposal;
    if (p.observedAt && Date.parse(p.observedAt) > now) return [];
    if (!p.startAt) return [item];
    const start = Date.parse(p.startAt);
    if (start >= now) return [];
    if (!p.endAt || Date.parse(p.endAt) <= now) return [item];
    const endAt = new Date(now).toISOString();
    const workedMinutes = p.workedMinutes === null ? null : Math.round((now - start) / 60_000) || null;
    const claims = item.claims?.map(claim => ({ ...claim, to: claim.to === null ? null : Math.min(claim.to, now) }));
    return [{ ...item, claims, proposal: { ...p, endAt, workedMinutes } }];
  });
}

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
    if (event.assigneeUserId && event.assigneeUserId !== userId && !(userId && event.participantUserId === userId)) return [];
    let startAt = event.allDay ? null : zonedInstant(event.start, event.timeZone);
    const observationStart = startAt ? Date.parse(startAt) : undefined;
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
      workedMinutes: source === "calendar" && minutes > 0 && minutes <= 1440 ? minutes : null,
    };
    const item: WorkdayEvidence = { eventKey, proposal: { ...body, source, key: randomUUID(), digest: digest(body), dismissed: false } };
    if (source === "calendar") {
      const [wireClaim] = claimsFor(item);
      const stableClaim = { ...wireClaim, observationStart,
        id: digest(["calendar-item", event.itemId, event.recurring ? event.id : "", date]) };
      item.claims = [wireClaim, stableClaim];
    }
    return [item];
  });
}
