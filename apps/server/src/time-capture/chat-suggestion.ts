import type { z } from "zod";
import { timeActivities, type CaptureProposal, type WorkdayGuideline, type TimesheetState } from "../back-office/timesheet-schema.js";
import { ApiError } from "../errors.js";
import type { chatWorkdayAction } from "./chat-workday-schema.js";
import { correctWorkday } from "./correct-workday.js";
import { proposedWorkdayCharge } from "./reconstruct-workday.js";
import { captureMatter, draftRules } from "./workday-context.js";

type Update = Extract<z.infer<typeof chatWorkdayAction>, { action: "update_suggestion" }>;

/** Reuse the private editor's correction and draft rebasing; never create a time record. */
export function updateChatSuggestion(saved: Parameters<typeof correctWorkday>[0], input: Update,
  proposal: CaptureProposal, state: TimesheetState, guidelines: WorkdayGuideline[], workspaceIds: Set<string>, zone: string) {
  const draft = saved.drafts[input.key];
  if (proposal.digest !== input.digest || proposal.dismissed || (draft?.revision ?? 0) !== input.draftRevision ||
      (draft && (draft.proposalDigest !== input.digest || draft.date !== input.date)))
    throw new ApiError(409, "private_workday_changed", "The suggestion changed. Read the day again before editing it.");
  const { changes } = input;
  const edited = new Set<"narrative" | "matter" | "activity" | "time">();
  if (changes.narrative !== undefined) edited.add("narrative");
  if (changes.matterId !== undefined) edited.add("matter");
  if (changes.activity !== undefined) edited.add("activity");
  if (changes.recordedMinutes !== undefined || changes.startAt !== undefined) edited.add("time");
  // Existing form edits still determine pricing when the user changes only time or wording.
  const values = draft?.values;
  const draftMatter = values?.workflow === true ? values.matterId : values?.matter;
  const matterId = changes.matterId !== undefined ? changes.matterId
    : typeof draftMatter === "string" || draftMatter === null ? draftMatter : captureMatter(proposal, state)?.id;
  const matter = state.matters.find(item => item.id === matterId);
  if (matterId && !matter) throw new ApiError(403, "private_workday_scope", "Choose an available matter.");
  let projectId = proposal.projectId;
  if (edited.has("matter") && !state.projects.some(project => project.id === projectId && matterId && project.matterIds.includes(matterId))) projectId = null;
  if (projectId && !workspaceIds.has(projectId)) throw new ApiError(403, "private_workday_scope", "This project is no longer available.");
  const ruleProject = state.projects.find(project => project.id === projectId && matterId && project.matterIds.includes(matterId));
  const rules = matter ? draftRules(state, guidelines, matter, input.date, ruleProject?.id) : undefined;
  const activity = changes.activity !== undefined ? changes.activity ?? ""
    : typeof values?.activity === "string" ? values.activity : proposal.activity;
  if (changes.activity && !Object.hasOwn(timeActivities, changes.activity) && !Object.hasOwn(rules?.activityLabels ?? {}, changes.activity))
    throw new ApiError(400, "private_workday_input", "Choose an available activity code.");
  // A user-provided duration is not evidence of a clock interval.
  const startAt = changes.startAt !== undefined ? changes.startAt : edited.has("time") ? null : proposal.startAt;
  const endAt = changes.endAt !== undefined ? changes.endAt : edited.has("time") ? null : proposal.endAt;
  const measured = startAt && endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000) : null;
  const workedMinutes = changes.recordedMinutes !== undefined ? changes.recordedMinutes
    : changes.startAt !== undefined ? measured === 0 && proposal.source === "stopwatch" ? null : measured : proposal.workedMinutes;
  correctWorkday(saved, input.date, {
    type: "correct", key: input.key, digest: input.digest, draftRevision: draft ? input.draftRevision : undefined,
    narrative: changes.narrative ?? proposal.narrative,
    matterId: changes.matterId === undefined ? proposal.matterId ?? null : changes.matterId,
    projectId, activity: changes.activity, startAt, endAt, workedMinutes,
    ...(edited.has("time") ? { clearEstimate: true } : {}),
  }, zone, next => proposedWorkdayCharge({ ...next, activity }, rules), next => captureMatter(next, state)?.id, edited, "agent");
}
