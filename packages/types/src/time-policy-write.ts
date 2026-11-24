import { bindingTimeTerm, projectRelaxesTerm, type TimePolicy } from "@legalwork/types/timesheet-core";

type PolicyDirectory = { policies: TimePolicy[]; matters: { id: string; clientIds: string[] }[]; projects: { id: string; matterIds: string[] }[] };

/** Consent is supplied as a reason. The server records identity, time and exact client term(s). */
export function authorizeTimeIncrement(
  state: PolicyDirectory,
  policy: TimePolicy,
  authorizedBy: string,
  timeError: (message: string) => never,
): TimePolicy {
  const {
    agreementClientId: _legacyClient,
    agreementId: _legacyId,
    agreementProjects: _legacyProjects,
    allocationUnavailable: _legacyAllocation,
    nonHourlyAgreement: _legacyBasis,
    nonHourlyBasis: _legacyMode,
    incrementException: _untrusted,
    incrementExceptionReason: reason,
    ...rule
  } = policy;
  if (rule.stopwatchRoundUp !== undefined && rule.scope !== "matter")
    timeError("Set stopwatch rounding on a matter.");
  if (rule.bindingIncrement !== undefined && rule.scope !== "client")
    timeError("Only a client can bind its billing increment.");
  if (rule.bindingIncrement && rule.enforceIncrement === false)
    timeError("A binding client increment requires enforcement.");
  if (reason && rule.scope !== "project")
    timeError("Only a project can receive a documented exception to client terms.");
  if (rule.scope === "firm" || rule.scope === "client") return rule;
  const matters =
    rule.scope === "matter"
      ? state.matters.filter((m) => m.id === rule.targetId)
      : state.matters.filter((m) =>
          state.projects.find((p) => p.id === rule.targetId)?.matterIds.includes(m.id),
        );
  const clients = [...new Set(matters.flatMap((m) => m.clientIds))];
  const terms = clients.flatMap((id) => {
    const term = bindingTimeTerm(
      state.policies,
      id,
      rule.effectiveFrom,
      rule.scope === "project" ? rule.targetId : undefined,
    );
    return term && projectRelaxesTerm(rule, term) ? [term] : [];
  });
  if (!terms.length) return rule;
  if (rule.scope !== "project")
    timeError("Use an authorised project exception to change binding client terms.");
  if (!reason)
    timeError("Record a reason to authorise a project exception to the binding client increment.");
  return {
    ...rule,
    incrementExceptionReason: reason,
    incrementException: {
      reason,
      authorizedBy,
      authorizedAt: new Date().toISOString(),
      terms,
    },
  };
}
