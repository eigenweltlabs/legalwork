import type { TimeEntry, TimesheetCommand, TimesheetState } from "./timesheet-schema.js";
import { timeError } from "./timesheet-data.js";

type Original = Omit<NonNullable<TimeEntry["sharedOriginal"]>, "submittedRevision">;
type Submit = Extract<TimesheetCommand, { type: "submit" }>;
type FirmSubmission = {
  type: "submit";
  entries: { id: string; revision: number }[];
  reason?: string;
  sharedBillingOriginals: (Original & { id: string; revision: number; digest: string })[];
};

/** The device verifies its private source; the firm pins consent to the worker's submitted revision. */
export async function submitFirmComparisons(
  command: Submit,
  current: TimesheetState,
  readOriginals: () => Promise<ReadonlyMap<string, Original>>,
  submit: (body: FirmSubmission) => Promise<TimesheetState>,
) {
  if (!current.supportsBillingComparisons)
    timeError("The connected firm does not support billing comparisons. Submit without sharing.", 409);
  for (const ref of command.entries) {
    if (!ref.shareOriginal) continue;
    const entry = current.entries.find((e) => e.id === ref.id);
    if (!entry || entry.workerId !== current.userId || entry.authorId !== current.userId ||
        entry.revision !== ref.revision || entry.status !== "confirmed" || entry.source !== "suggestion" ||
        entry.groupId !== ref.shareOriginal.key || entry.proposalDigest !== ref.shareOriginal.digest)
      timeError("Refresh the selected entries before sharing.", 409);
  }
  const originals = await readOriginals();
  const sharedBillingOriginals = command.entries.flatMap(({ id, revision, shareOriginal }) => {
    if (!shareOriginal) return [];
    const original = originals.get(shareOriginal.digest);
    if (!original) timeError("The accepted original is unavailable on this device.", 409);
    const { activity, narrative, workedMinutes } = original;
    return [{ id, revision, digest: shareOriginal.digest, activity, narrative, workedMinutes }];
  });
  const result = await submit({
    type: "submit",
    entries: command.entries.map(({ id, revision }) => ({ id, revision })),
    reason: command.reason,
    sharedBillingOriginals,
  });
  for (const shared of sharedBillingOriginals) {
    const entry = result.entries.find((e) => e.id === shared.id);
    const accepted = entry?.sharedOriginal;
    if (entry?.status !== "submitted" || !accepted || accepted.submittedRevision !== shared.revision + 1 ||
        accepted.narrative !== shared.narrative || accepted.activity !== shared.activity ||
        accepted.workedMinutes !== shared.workedMinutes)
      timeError("The firm did not confirm the shared comparison. Refresh to check the submission.", 502);
  }
  return result;
}
