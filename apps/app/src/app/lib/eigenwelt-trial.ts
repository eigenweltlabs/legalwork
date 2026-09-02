/**
 * Trial-state derivation for the Eigenwelt subscription. New subscriptions
 * start with a 7-day card-upfront trial on the platform; the entitlements
 * payload carries `subscriptionStatus` (raw Stripe status) and `trialEndsAt`
 * (ISO). This module turns those into the three states the UI cares about:
 *
 *  - "active": the trial is running (status "trialing") — show days left.
 *  - "ended":  a trial happened but the subscription is no longer entitled
 *              (canceled during/after the trial, or the first charge failed
 *              terminally) — the paid models are gone; offer to subscribe.
 *  - "none":   no trial on record, or the trial converted to a paid
 *              subscription (status active/past_due) — nothing to show.
 *
 * Pure and dependency-free so it can back both the account view and the
 * composer banner, and be tested directly.
 */

/** Statuses that keep the org entitled — mirror of the platform's list. */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Whether a raw Stripe subscription status still grants the plan. The plan
 * string itself survives cancellation on the platform, so plan displays must
 * gate on this instead of showing a stale "PLUS" next to a lapsed account.
 */
export function isEigenweltEntitledStatus(status: string | null | undefined): boolean {
  return status != null && ENTITLED_STATUSES.has(status);
}

export type EigenweltTrialState =
  | { kind: "none" }
  | { kind: "active"; endsAt: Date; daysLeft: number }
  | { kind: "ended"; endedAt: Date };

const DAY_MS = 86_400_000;

export function eigenweltTrialState(
  entitlements:
    | { subscriptionStatus: string | null; trialEndsAt?: string | null }
    | null
    | undefined,
  now: number = Date.now(),
): EigenweltTrialState {
  const raw = entitlements?.trialEndsAt;
  if (!raw) return { kind: "none" };
  const ends = Date.parse(raw);
  if (!Number.isFinite(ends)) return { kind: "none" };

  const status = entitlements?.subscriptionStatus ?? null;
  if (status === "trialing") {
    // Webhook lag can leave "trialing" a moment past the end — clamp to 0
    // ("ends today") instead of going negative.
    return {
      kind: "active",
      endsAt: new Date(ends),
      daysLeft: Math.max(0, Math.ceil((ends - now) / DAY_MS)),
    };
  }
  // A non-trialing entitled status means the trial converted to a paid
  // subscription — no trial UI at all.
  if (status !== null && ENTITLED_STATUSES.has(status)) return { kind: "none" };
  return { kind: "ended", endedAt: new Date(ends) };
}
