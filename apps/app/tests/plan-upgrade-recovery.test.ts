import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { hasAssistantReplyAfter, planChangeRecovery } from "../src/react-app/domains/connections/usage-control/usage-recovery";
import { usageLimitFixture } from "../src/react-app/design-system/usage-limit-fixture";

describe("confirmed plan upgrades", () => {
  test("waits for the new member plan rather than relying on old usage or organization entitlements", () => {
    const { usage } = usageLimitFixture("plus", true, "eigenwelt");
    usage.me.remainingCents = 100;
    expect(planChangeRecovery(null, "pro")).toBe("checking");
    expect(planChangeRecovery(usage, "pro")).toBe("checking");
  });
  test("an upgrade with included usage resumes even when extra spending is exhausted", () => {
    const { usage } = usageLimitFixture("pro", true, "eigenwelt");
    usage.me.remainingCents = 923;
    usage.me.blockedReason = null;
    usage.walletCents = 0;
    usage.extraEnabled = false;
    expect(planChangeRecovery(usage, "pro")).toBe("ready");
  });
  test("does not hide a remaining personal or shared limit after confirming the new plan", () => {
    const { usage } = usageLimitFixture("pro", true, "eigenwelt");
    for (const reason of ["member_limit", "organization_limit", "wallet_empty", "extra_disabled"]) {
      usage.me.blockedReason = reason;
      expect(planChangeRecovery(usage, "pro")).toBe("blocked");
    }
    usage.me.blockedReason = null;
    expect(planChangeRecovery(usage, "pro")).toBe("blocked");
  });
});

describe("historical inline limit messages", () => {
  const limit: UIMessage = { id: "session-error:quota", role: "assistant", parts: [{ type: "text", text: "Limit reached" }] };
  const user: UIMessage = { id: "next-user", role: "user", parts: [{ type: "text", text: "Hallo?" }] };
  test("a user retry, another quota error, or an empty assistant is not confirmation of recovery", () => {
    expect(hasAssistantReplyAfter([limit, user], limit.id)).toBe(false);
    expect(hasAssistantReplyAfter([limit, user, { ...limit, id: "session-error:second" }], limit.id)).toBe(false);
    expect(hasAssistantReplyAfter([limit, user, { id: "placeholder", role: "assistant", parts: [] }], limit.id)).toBe(false);
  });
  test("a later assistant reply resolves only earlier errors", () => {
    const reply: UIMessage = { id: "reply", role: "assistant", parts: [{ type: "text", text: "Hallo! Ich bin da." }] };
    const nextLimit = { ...limit, id: "session-error:later" };
    expect(hasAssistantReplyAfter([limit, user, reply, nextLimit], limit.id)).toBe(true);
    expect(hasAssistantReplyAfter([limit, user, reply, nextLimit], nextLimit.id)).toBe(false);
    expect(hasAssistantReplyAfter([reply, limit], limit.id)).toBe(false);
    expect(hasAssistantReplyAfter([reply], "missing")).toBe(false);
  });
});
