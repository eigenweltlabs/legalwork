import { assignedTimeReviewer, resolveTimePolicy, type TimesheetState, type TimeEntry } from "@legalwork/types/timesheet";

export function invoiceEntryAccess(state: TimesheetState, entry: TimeEntry, clientId = entry.clientId) {
  const policy = resolveTimePolicy(
    state.policies,
    clientId,
    entry.matterId,
    entry.date,
    entry.projectId,
  );
  const solo = state.scope === "local" && policy.soloApproval;
  const reviewer =
    (policy.reviewerId === state.userId || (solo && !policy.reviewerId)) &&
    (entry.workerId !== state.userId || solo);
  const ownWithoutReviewer = entry.workerId === state.userId && !assignedTimeReviewer(policy, entry.workerId);
  const direct = entry.status === "confirmed" && ownWithoutReviewer;
  const authorized =
    (entry.status === "approved" && (reviewer || ownWithoutReviewer) || direct) &&
    !entry.legacy &&
    entry.billable &&
    Boolean(clientId) && entry.clientId === clientId;
  return { policy, authorized, direct };
}
