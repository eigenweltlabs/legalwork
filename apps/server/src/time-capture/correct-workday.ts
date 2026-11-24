import { randomUUID } from "node:crypto";
import type { CaptureProposal, WorkdayCorrection } from "@legalwork/types/time-capture";
import { dayInZone } from "../calendar/dates.js";
import { ApiError } from "../errors.js";
import { rebasePrivateDraft, type DraftStore } from "./private-edits.js";
import { proposalCommitment } from "./original.js";
import { claimsFor, type EvidenceClaim, type WorkdayEvidence } from "./private-workday.js";

type Day = DraftStore & {
  days: Record<string, WorkdayEvidence[]>;
  originals: Record<string, CaptureProposal>;
};
export function correctWorkday(saved: Day, date: string, command: WorkdayCorrection, zone: string,
  charge?: (proposal: CaptureProposal, split: boolean) => number | undefined,
  matterOf = (proposal: CaptureProposal) => proposal.matterId,
  editedFields: ReadonlySet<"narrative" | "matter" | "activity" | "time"> = new Set(),
  editor: "user" | "agent" = "user") {
  const day = saved.days[date] ?? [];
  const item = day.find((item) => item.proposal.key === command.key);
  if (!item || item.proposal.dismissed || item.proposal.digest !== command.digest)
    throw new ApiError(409, "private_workday_changed", "Refresh the proposal before editing it.");
  const parent = item.proposal;
  // Preserve earlier user edits across later agent edits. Legacy corrections
  // without provenance remain protected until their origin is established.
  const userEdited = editor === "user" || Boolean(saved.drafts[parent.key]) ||
    (item.userEdited ?? Boolean(parent.parentDigest));
  if (parent.source === "stopwatch" && command.projectId)
    throw new ApiError(400, "stopwatch_matter", "A stopwatch can be assigned directly to a matter.");
  const start = command.startAt ? Date.parse(command.startAt) : null,
    end = command.endAt ? Date.parse(command.endAt) : null;
  const elapsed = start !== null && end !== null ? (end - start) / 60000 : null;
  const rounded = elapsed === null ? null : Math.round(elapsed);
  const workedMinutes = rounded === 0 && parent.source === "stopwatch" ? null : rounded;
  if (
    (start === null) !== (end === null) ||
    (elapsed !== null &&
      (elapsed <= 0 ||
        elapsed > 1440 ||
        workedMinutes !== command.workedMinutes ||
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
  if (moved && parent.source === "stopwatch")
    throw new ApiError(400, "invalid_correction_split", "A stopped timer can be recorded only once.");
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
    activity: command.activity === undefined ? parent.activity : command.activity ?? "",
    narrative: command.narrative,
    parentDigest: parent.digest,
  };
  if (remaining.workedMinutes !== null || remaining.startAt || command.clearEstimate) {
    delete remaining.estimatedMinutes;
    delete remaining.estimateReason;
  }
  const timeChanged = editedFields.has("time") || parent.estimatedMinutes !== remaining.estimatedMinutes || parent.startAt !== remaining.startAt || parent.endAt !== remaining.endAt ||
    parent.workedMinutes !== remaining.workedMinutes;
  const matterChanged = editedFields.has("matter") || matterOf(parent) !== matterOf(remaining);
  if (matterChanged) delete remaining.workProductId;
  const assignmentChanged = matterChanged || parent.projectId !== remaining.projectId;
  const activityChanged = editedFields.has("activity") || parent.activity !== remaining.activity;
  const chargeChanged = timeChanged || assignmentChanged || activityChanged;
  if (chargeChanged) remaining.chargeMinutes = charge?.(remaining, false);
  const replaced = [
    ...(editedFields.has("narrative") || parent.narrative !== remaining.narrative ? ["name", "billingNarrative", "narrative"] : []),
    ...(activityChanged ? ["activity"] : []),
    ...(timeChanged ? ["worked", "billableWork", "billable", "workedMinutes", "recordedMinutes", "startedAt", "endedAt", "nonBillable", "nonBillableMinutes"] : []),
    ...(assignmentChanged ? ["matter", "matterId", "client", "clientId", "projectId", "workProduct", "workProductId", "workProductTitle", "createWorkProduct", "product", "productId", "createProduct"] : []),
    ...(chargeChanged ? ["charge", "chargeMinutes", "billableMinutes", "manualCharge"] : []),
  ];
  remaining.digest = proposalCommitment(remaining);
  rebasePrivateDraft(saved, parent.key, date, parent.digest, remaining.digest, command.draftRevision, replaced);
  saved.originals[parent.digest] = parent;
  saved.originals[remaining.digest] = remaining;
  item.proposal = remaining;
  item.userEdited = userEdited;
  if (command.split) {
    // Only the interval a human assigned to each segment can carry an existing claim.
    const sourceClaims = claimsFor({ ...item, proposal: parent });
    const cut = boundary ? Date.parse(boundary) : null;
    const part = (claim: EvidenceClaim, split: boolean): EvidenceClaim[] => {
      if (cut === null || claim.from === null || claim.to === null) return split ? [] : [claim];
      const span = split ? { from: Math.max(cut, claim.from), to: claim.to } : { from: claim.from, to: Math.min(cut, claim.to) };
      return span.from < span.to ? [{ ...claim, ...span }] : [];
    };
    item.claims = sourceClaims.flatMap(claim => part(claim, false));
    const segment: CaptureProposal = {
      ...remaining,
      key: randomUUID(),
      startAt: boundary,
      endAt: command.endAt,
      workedMinutes: moved,
      matterId: command.split.matterId,
      projectId: command.split.projectId,
      workProductId: undefined,
    };
    segment.chargeMinutes = charge?.(segment, true);
    segment.digest = proposalCommitment(segment);
    saved.originals[segment.digest] = segment;
    const eventKey = item.eventKey + "/" + segment.key;
    const claims = sourceClaims.flatMap(claim => part(claim, true));
    day.push({ eventKey, proposal: segment, userEdited, sourceDocumentTitle: item.sourceDocumentTitle, ...(claims.length ? { claims } : {}) });
  }
}
