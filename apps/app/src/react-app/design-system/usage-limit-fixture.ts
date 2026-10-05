import type { UsageControlView } from "@legalwork/types/usage-control";
import type { EigenweltEntitlementsView } from "@/app/lib/legalwork-server";
import type { EigenweltPlanId } from "@/app/lib/eigenwelt-plans";

/** Sample read models for the dev-only session preview. No account is connected. */
export function usageLimitFixture(plan: EigenweltPlanId | null, isAdmin: boolean, providerId: string) {
  const allowance = plan === "pro" ? 1616 : plan === "plus" ? 693 : 0;
  const usage: UsageControlView = {
    version: 1, enabled: plan !== null, isAdmin,
    me: {
      userId: "visual-user", name: "Anna Berg", email: "anna@example.test",
      role: isAdmin ? "org:admin" : "org:member", plan: plan ?? "none",
      allowanceCents: allowance, remainingCents: 0,
      baseExtraLimitCents: 2000, extraLimitCents: 2000,
      extraUsedCents: providerId === "eigenwelt" ? 2000 : 0,
      extraRemainingCents: providerId === "eigenwelt" ? 0 : 2000,
      inheritsLimit: true, resetsAt: "2026-10-05T00:00:00Z", extraResetsAt: "2026-10-01T00:00:00Z",
      blockedReason: providerId === "eigenwelt" ? "member_limit" : null,
    },
    members: [], requests: [], walletCents: isAdmin ? 31999 : null,
    orgExtraUsedCents: isAdmin ? 4000 : null, orgExtraLimitCents: isAdmin ? 50000 : null,
    extraEnabled: true, defaultExtraLimitCents: 2000,
    seats: { sync: plan === "sync" ? 1 : 0, plus: plan === "plus" ? 1 : 0, pro: plan === "pro" ? 1 : 0 },
    billingInterval: "month",
  };
  usage.members = [usage.me];
  const entitlements: EigenweltEntitlementsView = {
    connected: plan !== null, platformURL: "https://legalwork-preview.invalid",
    account: plan ? { userId: "visual-user", userName: "Anna Berg", userEmail: "anna@example.test", orgId: "visual-org", orgName: "Northstar Legal" } : null,
    entitlements: plan ? {
      plan, subscriptionStatus: "active", seats: 1,
      features: ["admin_hub", "settings_presets", "org_management", "premium_models", "intake"],
      usage: {
        window: "week", allowanceCents: allowance, remainingCents: 0, usedPercent: 100, resetsAt: usage.me.resetsAt,
        dailyAllowanceCents: allowance, dailyRemainingCents: 0, dailyUsedPercent: 100,
        extraUsageEnabled: true, prepaidBalanceCents: 31999,
      },
    } : null,
  };
  return { usage, entitlements };
}
