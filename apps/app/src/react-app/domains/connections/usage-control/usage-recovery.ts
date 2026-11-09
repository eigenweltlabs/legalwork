import type { UIMessage } from "ai";
import type { BillingPaymentDetails, UsageControlAction, UsageControlView } from "@legalwork/types/usage-control";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import type { UsageLimitDetails } from "@legalwork/types/provider-usage-limit";

/** A later user message or an empty assistant placeholder is not recovery. */
export function hasAssistantReplyAfter(messages: UIMessage[], messageId: string) {
  const index = messages.findIndex(message => message.id === messageId);
  return index >= 0 && messages.slice(index + 1).some(message =>
    message.role === "assistant" && !message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) &&
    message.parts.some(part => part.type === "text" && part.text.trim().length > 0),
  );
}

/** Only the refreshed member allowance can resolve a confirmed plan change. */
export function planChangeRecovery(view: UsageControlView | null, plan: "plus" | "pro", limit?: UsageLimitDetails | null) {
  if (!view?.enabled || view.me.plan !== plan) return "checking";
  return usageIsAvailable(view, limit) ? "ready" : "blocked";
}

export function availableUsageMicros(view: UsageControlView) {
  return view.me.availableMicros ?? (view.me.remainingCents + view.me.extraRemainingCents) * 10_000;
}

export function usageIsAvailable(view: UsageControlView, limit?: UsageLimitDetails | null) {
  // Member allowance cannot establish recovery for a separate service key.
  if (limit?.reason === "service_limit") return false;
  return view.enabled && view.me.blockedReason === null && availableUsageMicros(view) >= (limit?.requiredMicros ?? 1);
}

export function requestUsageBlockReason(view: UsageControlView, limit?: UsageLimitDetails | null) {
  if (limit?.reason === "service_limit") return limit.reason;
  if (usageIsAvailable(view, limit)) return null;
  return view.me.blockedReason ?? (limit ? view.me.requestLimitReason ?? limit.reason : null);
}

export type TopUpRecovery = {
  status: "checking" | "ready" | "blocked";
  view: UsageControlView | null;
  refreshFailed: boolean;
};

export const CHECKING_TOP_UP: TopUpRecovery = { status: "checking", view: null, refreshFailed: false };

export function isCardTopUpAction(action: UsageControlAction) {
  return action.action === "topUp" || action.action === "resumeTopUp" || action.action === "cancelTopUp";
}

/** A paid operation leaves the pending list only after its verified credit grant is applied.
 * Read usage afterwards so a webhook completing between reads cannot leave a stale allowance.
 * These checks never submit or retry a payment.
 */
export async function checkConfirmedTopUp(
  operationId: string,
  readPaymentDetails: () => Promise<BillingPaymentDetails>,
  readUsage: () => Promise<UsageControlView>,
  limit?: UsageLimitDetails | null,
): Promise<TopUpRecovery> {
  try {
    const details = await readPaymentDetails();
    if (details.pendingTopUps.some(pending => pending.operationId === operationId)) return CHECKING_TOP_UP;
    const view = await readUsage();
    if (!view.enabled) return { ...CHECKING_TOP_UP, view };
    return { status: usageIsAvailable(view, limit) ? "ready" : "blocked", view, refreshFailed: false };
  } catch {
    return { ...CHECKING_TOP_UP, refreshFailed: true };
  }
}
