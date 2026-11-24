import { authorizeTimeIncrement } from "./timesheet-schema.js";
import type { TimePolicy, TimesheetState } from "./timesheet-schema.js";
import type { BackOfficeActor } from "./schema.js";
import { timeError } from "./timesheet-data.js";

export function authorizeIncrement(state: TimesheetState, policy: TimePolicy, actor: BackOfficeActor) {
  if (!state.canManage || !actor.edit || !actor.finance)
    timeError("Billing configuration access is required.", 403);
  return authorizeTimeIncrement(state, policy, actor.userId, timeError);
}
