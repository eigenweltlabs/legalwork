import type { UIMessage } from "ai";
import type { BillingPaymentDetails, UsageControlAction, UsageControlView } from "@legalwork/types/usage-control";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";

/** A later user message or an empty assistant placeholder is not recovery. */
export function hasAssistantReplyAfter(messages: UIMessage[], messageId: string) {
  const index = messages.findIndex(message => message.id === messageId);
  return index >= 0 && messages.slice(index + 1).some(message =>
    message.role === "assistant" && !message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) &&
    message.parts.some(part => part.type === "text" && part.text.trim().length > 0),
  );
}

/** Only the refreshed member allowance can resolve a confirmed plan change. */
export function planChangeRecovery(view: UsageControlView | null, plan: "plus" | "pro") {
  if (!view?.enabled || view.me.plan !== plan) return "checking";
  return usageIsAvailable(view) ? "ready" : "blocked";
}

export function usageIsAvailable(view: UsageControlView) {
  return view.enabled && view.me.blockedReason === null && (view.me.remainingCents > 0 || view.me.extraRemainingCents > 0);
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
): Promise<TopUpRecovery> {
  try {
    const details = await readPaymentDetails();
    if (details.pendingTopUps.some(pending => pending.operationId === operationId)) return CHECKING_TOP_UP;
    const view = await readUsage();
    if (!view.enabled) return { ...CHECKING_TOP_UP, view };
    return { status: usageIsAvailable(view) ? "ready" : "blocked", view, refreshFailed: false };
  } catch {
    return { ...CHECKING_TOP_UP, refreshFailed: true };
  }
}
