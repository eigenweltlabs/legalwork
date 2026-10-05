import type { UsageControlAction, UsageControlView } from "@legalwork/types/usage-control";

export type UsageIntent = "personal" | "organization" | "enable";
export function usageIntentForReason(reason: string | null): UsageIntent | null {
  if (reason === "member_limit") return "personal";
  if (reason === "organization_limit") return "organization";
  if (reason === "extra_disabled") return "enable";
  return null;
}

export function usageIntentAction(view: UsageControlView, intent: UsageIntent, limitCents: number): UsageControlAction {
  if (!view.enabled || !view.isAdmin) throw new Error("admin_required");
  if (intent === "enable") return { action: "enableExtraUsage" };
  const current = intent === "personal" ? view.me.baseExtraLimitCents : view.orgExtraLimitCents;
  if (current === null || !Number.isSafeInteger(limitCents) || limitCents <= 0 || limitCents <= current || limitCents > 5_000_000) throw new Error("limit_must_increase");
  return { action: "increaseLimit", scope: intent, limitCents };
}
