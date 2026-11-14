import { randomUUID } from "node:crypto";
import type { CaptureProposal, WorkdayCorrection } from "@legalwork/types/time-capture";
import { dayInZone } from "../calendar/dates.js";
import { ApiError } from "../errors.js";
import { proposalCommitment } from "./original.js";
import type { WorkdayEvidence } from "./private-workday.js";

type Day = { days: Record<string, WorkdayEvidence[]>; originals: Record<string, CaptureProposal> };
export function correctWorkday(saved: Day, date: string, command: WorkdayCorrection, zone: string) {
  const day = saved.days[date] ?? [];
  const item = day.find((item) => item.proposal.key === command.key);
  if (!item || item.proposal.dismissed || item.proposal.digest !== command.digest)
    throw new ApiError(409, "private_workday_changed", "Refresh the proposal before editing it.");
  const parent = item.proposal;
  const start = command.startAt ? Date.parse(command.startAt) : null,
    end = command.endAt ? Date.parse(command.endAt) : null;
  const elapsed = start !== null && end !== null ? (end - start) / 60000 : null;
  if (
    (start === null) !== (end === null) ||
    (elapsed !== null &&
      (elapsed <= 0 ||
        elapsed > 1440 ||
        Math.round(elapsed) !== command.workedMinutes ||
        dayInZone(command.startAt!, zone) !== date ||
        dayInZone(new Date(end! - 1).toISOString(), zone) !== date))
  )
    throw new ApiError(
      400,
      "invalid_correction_range",
      "The start and end must describe a positive duration on the selected workday.",
    );
  const moved = command.split?.minutes ?? 0,
    total = command.workedMinutes;
  if (
    moved &&
    (total === null ||
      moved >= total ||
      !command.matterId ||
      command.split?.matterId === command.matterId)
  )
    throw new ApiError(
      400,
      "invalid_correction_split",
      "Choose two different matters and leave at least one minute in each.",
    );
  const boundary = end !== null && moved > 0 ? new Date(end - moved * 60000).toISOString() : null;
  const remaining: CaptureProposal = {
    ...parent,
    startAt: command.startAt,
    endAt: boundary ?? command.endAt,
    workedMinutes: total === null ? null : total - moved,
    projectId: command.projectId,
    matterId: command.matterId ?? undefined,
    narrative: command.narrative,
    parentDigest: parent.digest,
  };
  remaining.digest = proposalCommitment(remaining);
  saved.originals[parent.digest] = parent;
  saved.originals[remaining.digest] = remaining;
  item.proposal = remaining;
  if (command.split) {
    const segment: CaptureProposal = {
      ...remaining,
      key: randomUUID(),
      startAt: boundary,
      endAt: command.endAt,
      workedMinutes: moved,
      matterId: command.split.matterId,
      projectId: command.split.projectId,
    };
    segment.digest = proposalCommitment(segment);
    saved.originals[segment.digest] = segment;
    day.push({ eventKey: item.eventKey + "/" + segment.key, proposal: segment });
  }
}
