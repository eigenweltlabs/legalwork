import type { AssistantSubmission } from "@legalwork/types/launcher";

/** A stable client identity exists before dispatch; a retry reuses both IDs. */
export function createSubmissionIdentity(now = Date.now()) {
  const time = BigInt.asUintN(48, BigInt(now) * 4096n).toString(16).padStart(12, "0");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 14);
  return { requestId: `req_${crypto.randomUUID().replaceAll("-", "")}`, messageId: `msg_${time}${suffix}`, createdAt: now };
}
export type SubmissionIdentity = ReturnType<typeof createSubmissionIdentity>;

export const TERMINAL_SUBMISSION_STATES = new Set<AssistantSubmission["state"]>(["completed", "failed"]);
/** Unconfirmed and sending states keep polling with the same identity instead of resubmitting. */
export function nextSubmissionPollMs(state: AssistantSubmission["state"], attempt: number) {
  if (TERMINAL_SUBMISSION_STATES.has(state)) return null;
  if (state === "unconfirmed" || state === "sending") return Math.min(5000, 1000 * 2 ** Math.min(attempt, 2));
  return 2000;
}
