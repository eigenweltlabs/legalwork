import {
  hasTimeEntryPrice, timeEntryError, timeEntryPrice, timePolicyError, timeActivities,
  type resolveTimePolicy, type TimeEntry,
} from "@legalwork/types/timesheet-core";
import { suggestBillingNarrative } from "@legalwork/types/billing-narrative";

type Policy = ReturnType<typeof resolveTimePolicy>;
type ApprovalAction =
  | { type: "submit" | "approve" | "return"; reason?: string }
  | { type: "review"; narrative: string; billableMinutes: number; approve?: true };
type Decision = { entry: TimeEntry } | { status: 400 | 403 | 409; message: string };

export function timeApprovalPrice(entry: TimeEntry, policy: Policy, policyDigest: string) {
  return {
    ...timeEntryPrice(policy, entry.workerId), policyDigest,
    activityLabel: policy.activityLabels[entry.activity] ??
      (Object.hasOwn(timeActivities, entry.activity) ? timeActivities[entry.activity] : entry.activity),
  };
}

export function changeTimeApproval(entry: TimeEntry, action: ApprovalAction, context: {
  actorId: string;
  canReview: boolean;
  policy: Policy;
  policyDigest: string;
}): Decision {
  const { actorId, canReview, policy, policyDigest } = context;
  if (action.type === "submit") {
    if (entry.workerId !== actorId)
      return { status: 403, message: "Only the worker can submit this entry." };
    if (entry.status !== "confirmed")
      return { status: 409, message: "The entry is no longer at this stage." };
  } else {
    if (!canReview) return { status: 403, message: "An assigned independent billing reviewer must perform this action." };
    if (entry.status !== "submitted") return { status: 409, message: "Review a submitted revision." };
  }

  if (action.type === "return") {
    return { entry: { ...entry, status: "confirmed", suggestion: undefined, sharedOriginal: undefined } };
  }
  if (action.type === "review") {
    const next = { ...entry, narrative: action.narrative, billableMinutes: action.billableMinutes };
    const error = timeEntryError(next, policy);
    if (error) return { status: 400, message: error };
    const reviewed = { ...next, ...timeApprovalPrice(next, policy, policyDigest), suggestion: suggestBillingNarrative(next, policy) };
    return action.approve ? changeTimeApproval(reviewed, { type: "approve" }, context) : { entry: reviewed };
  }

  if (entry.billable && policy.ambiguousAgreement)
    return { status: 409, message: "Several fee agreements apply. Select the intended agreement before submitting or approving." };
  const error = action.type === "approve" ? timePolicyError(entry, policy) : timeEntryError(entry, policy);
  if (error) return { status: 400, message: error };
  const terms = timeApprovalPrice(entry, policy, policyDigest);
  if (action.type === "submit") return {
    entry: { ...entry, ...terms, status: "submitted", submittedNarrative: entry.narrative,
      suggestion: suggestBillingNarrative(entry, policy), sharedOriginal: undefined },
  };

  if (entry.billable && !entry.clientId)
    return { status: 400, message: "Choose the invoice recipient before approving billable time." };
  if (entry.billable && !policy.nonHourlyAgreement && !hasTimeEntryPrice(terms))
    return { status: 409, message: "Set an hourly rate and currency for the service date before approving this billable entry." };
  if (entry.policyDigest !== policyDigest)
    return { status: 409, message: "The applicable billing terms changed. Review the entry again or return it for resubmission." };
  return {
    entry: { ...entry, ...terms, status: "approved", suggestion: undefined,
      nonHourlyApproval: entry.billable && policy.nonHourlyAgreement ? true : undefined,
      nonHourlyBasis: entry.billable && policy.nonHourlyAgreement ? policy.nonHourlyBasis : undefined },
  };
}
