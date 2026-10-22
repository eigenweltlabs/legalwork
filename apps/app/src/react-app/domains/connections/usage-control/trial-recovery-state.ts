import type { TrialSubscriptionResult, UsageControlView } from "@legalwork/types/usage-control";
import type { UsageLimitDetails } from "@legalwork/types/provider-usage-limit";
import { requestUsageBlockReason, usageIsAvailable } from "./usage-recovery";

export function parseTrialSubscriptionResult(value: unknown): TrialSubscriptionResult {
  if (typeof value !== "object" || value === null || !("quoteId" in value) || typeof value.quoteId !== "string") throw new Error("response");
  if ("amountCents" in value && typeof value.amountCents === "number" && Number.isSafeInteger(value.amountCents) && value.amountCents >= 0 &&
      "recurringAmountCents" in value && typeof value.recurringAmountCents === "number" && Number.isSafeInteger(value.recurringAmountCents) && value.recurringAmountCents >= 0 &&
      "seatCount" in value && typeof value.seatCount === "number" && Number.isSafeInteger(value.seatCount) && value.seatCount > 0 &&
      "billingInterval" in value && (value.billingInterval === "month" || value.billingInterval === "year"))
    return { quoteId: value.quoteId, amountCents: value.amountCents, recurringAmountCents: value.recurringAmountCents, seatCount: value.seatCount, billingInterval: value.billingInterval };
  if ("status" in value) {
    if (value.status === "paid" || value.status === "processing" || value.status === "canceled") return { quoteId: value.quoteId, status: value.status };
    if (value.status === "requires_payment" && "url" in value && typeof value.url === "string") return { quoteId: value.quoteId, status: value.status, url: value.url };
  }
  throw new Error("response");
}
export function trialAllowanceExhausted(view: UsageControlView | null, providerId: string, limit?: UsageLimitDetails | null) {
  if (!(view?.enabled && view.trial && providerId === "eigenwelt" &&
    (view.me.plan === "plus" || view.me.plan === "pro") && view.me.remainingCents === 0 &&
    !usageIsAvailable(view, limit))) return false;
  const reason = requestUsageBlockReason(view, limit);
  // Explain an actionable spending boundary before offering another purchase.
  if (reason === "member_limit" || reason === "organization_limit" || reason === "seat_required" || reason === "service_limit") return false;
  // Without wallet visibility, direct a member to their admin rather than a top-up.
  if (reason === "extra_disabled") return view.walletCents === 0;
  return true;
}
