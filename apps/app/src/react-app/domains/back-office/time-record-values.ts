import type { BackOfficeValue } from "@legalwork/types/back-office";
import { captureChargeMinutes, type CaptureProposal } from "@legalwork/types/time-capture";
import { proposedCharge, proposedStopwatchCharge, resolveTimePolicy, type TimesheetState } from "@legalwork/types/timesheet";
import { calendarDay } from "../calendar/calendar-format";

type Values = Record<string, BackOfficeValue>;

/** Date-only records must never shift to the preceding day in western time zones. */
export function timeRecordDate(value: BackOfficeValue | undefined): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : calendarDay(new Date(value));
}

export function proposalValues(proposal: CaptureProposal, state: TimesheetState): Values {
  const project = state.projects.find(project => project.id === proposal.projectId);
  const matter = state.matters.find(matter => matter.id === proposal.matterId)
    ?? (project?.matterIds.length === 1 ? state.matters.find(matter => matter.id === project.matterIds[0]) : undefined);
  const clientId = matter?.clientIds.length === 1 ? matter.clientIds[0] : "";
  const policy = resolveTimePolicy(state.policies, clientId, matter?.id ?? "", proposal.date, project?.id);
  const duration = captureChargeMinutes(proposal);
  const narrative = proposal.source === "stopwatch" && !proposal.parentDigest ? "" : proposal.narrative;
  return { name: narrative.slice(0, 240), billingNarrative: narrative, status: "Draft", matter: matter?.id ?? null, client: clientId || null,
    startedAt: proposal.startAt ?? proposal.date, endedAt: proposal.endAt, recordedMinutes: proposal.source === "stopwatch" && duration !== null ? proposedStopwatchCharge(duration, policy) : proposal.workedMinutes,
    billableMinutes: duration === null ? null : proposal.source === "stopwatch" ? proposedStopwatchCharge(duration, policy) : proposedCharge(duration, policy) };
}

