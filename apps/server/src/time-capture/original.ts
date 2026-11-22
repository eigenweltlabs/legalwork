import { createHash } from "node:crypto";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { ApiError } from "../errors.js";

/** The private, stable proposal key acts as a nonce. Shared digests do not reveal event IDs or content. */
export function proposalCommitment(p: CaptureProposal) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "legalwork.timesheet.proposal.v1",
        p.key,
        p.date,
        p.source,
        p.account ?? null,
        p.projectId,
        p.activity,
        p.narrative,
        p.startAt,
        p.endAt,
        p.workedMinutes,
        ...(p.estimatedMinutes !== undefined ? ["estimate", p.estimatedMinutes, p.estimateReason ?? null, p.observedAt ?? null] : []),
        ...(p.matterId || p.parentDigest ? [p.matterId ?? null, p.parentDigest ?? null] : []),
        ...(p.documentId || p.workProductId || p.chargeMinutes !== undefined
          ? ["scoped-context", p.documentId ?? null, p.workProductId ?? null, p.chargeMinutes ?? null] : []),
      ]),
    )
    .digest("hex");
}
export function originalCaptureProposal(
  original: CaptureProposal | undefined,
  digest: string,
  originals: Record<string, CaptureProposal> = {},
) {
  if (!original)
    throw new ApiError(404, "private_original_missing", "This original is unavailable on this device.");
  if (original.digest !== digest || proposalCommitment(original) !== digest)
    throw new ApiError(
      409,
      "private_original_changed",
      "The original does not match the saved revision reference.",
    );
  let current: CaptureProposal = original;
  const visited = new Set([digest]);
  while (current.parentDigest) {
    const parent: CaptureProposal | undefined = originals[current.parentDigest];
    if (
      !parent ||
      visited.has(parent.digest) ||
      parent.digest !== current.parentDigest ||
      proposalCommitment(parent) !== parent.digest
    )
      throw new ApiError(
        409,
        "private_original_changed",
        "The private proposal history could not be verified.",
      );
    visited.add(parent.digest);
    current = parent;
  }
  return current;
}

export function originalBillingComparison(original: CaptureProposal | undefined, digest: string, originals: Record<string, CaptureProposal> = {}) {
  const current = originalCaptureProposal(original, digest, originals);
  const { date, activity, narrative, workedMinutes } = current;
  return {
    digest,
    ...(current.digest !== digest ? { originalDigest: current.digest } : {}),
    date,
    activity,
    narrative,
    workedMinutes,
    ...(current.estimatedMinutes !== undefined ? { estimatedMinutes: current.estimatedMinutes, estimateReason: current.estimateReason } : {}),
  };
}
