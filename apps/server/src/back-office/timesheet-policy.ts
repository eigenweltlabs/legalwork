import {
  bindingTimeTerm,
  projectRelaxesTerm,
  type TimePolicy,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import type { BackOfficeActor } from "./schema.js";
import { timeError } from "./timesheet-data.js";

/** Consent is supplied as a reason. The server records identity, time and exact client term(s). */
export function authorizeIncrement(
  state: TimesheetState,
  policy: TimePolicy,
  actor: BackOfficeActor,
): TimePolicy {
  const {
    agreementClientId: _legacyClient,
    incrementException: _untrusted,
    incrementExceptionReason: reason,
    ...rule
  } = policy;
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
    const term = bindingTimeTerm(state.policies, id, rule.effectiveFrom);
    return term && projectRelaxesTerm(rule, term) ? [term] : [];
  });
  if (!terms.length) return rule;
  if (rule.scope !== "project")
    timeError("Use an authorised project exception to change binding client terms.");
  if (!state.canManage || !actor.edit || !actor.finance)
    timeError("Billing configuration access is required to authorise an exception.", 403);
  if (!reason)
    timeError("Record a reason to authorise a project exception to the binding client increment.");
  return {
    ...rule,
    incrementExceptionReason: reason,
    incrementException: {
      reason,
      authorizedBy: actor.userId,
      authorizedAt: new Date().toISOString(),
      terms,
    },
  };
}
