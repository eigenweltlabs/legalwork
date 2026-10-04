import { describe, expect, test } from "bun:test";
import { usageLimitFixture } from "../src/react-app/design-system/usage-limit-fixture";
import { usageIntentAction, usageIntentForReason } from "../src/react-app/domains/connections/usage-control/usage-intent";
import { parseUsageAmount } from "../src/react-app/domains/connections/usage-control/transport";

describe("focused usage intents", () => {
  test("wallet exhaustion and provider limits cannot trigger a spending-limit mutation", () => {
    expect(usageIntentForReason("member_limit")).toBe("personal");
    expect(usageIntentForReason("organization_limit")).toBe("organization");
    expect(usageIntentForReason("extra_disabled")).toBe("enable");
    for (const reason of [null, "wallet_empty", "seat_required", "rate_limit_exceeded"])
      expect(usageIntentForReason(reason)).toBeNull();
  });
  test("personal increases carry no user ID or unrelated settings", () => {
    const { usage } = usageLimitFixture("plus", true, "eigenwelt");
    expect(usageIntentAction(usage, "personal", 5000)).toEqual({ action: "increaseLimit", scope: "personal", limitCents: 5000 });
    expect(usageIntentAction(usage, "organization", 60000)).toEqual({ action: "increaseLimit", scope: "organization", limitCents: 60000 });
    expect(usageIntentAction(usage, "enable", 0)).toEqual({ action: "enableExtraUsage" });
  });
  test("members and disabled organizations cannot issue admin intents", () => {
    const { usage } = usageLimitFixture("sync", false, "eigenwelt");
    expect(() => usageIntentAction(usage, "personal", 5000)).toThrow("admin_required");
    expect(() => usageIntentAction(usage, "enable", 0)).toThrow("admin_required");
    expect(() => usageIntentAction({ ...usage, isAdmin: true, enabled: false }, "enable", 0)).toThrow("admin_required");
  });
  test("cannot reduce a cap or replace an unlimited organization cap", () => {
    const { usage } = usageLimitFixture("plus", true, "eigenwelt");
    for (const amount of [-1, 0, 1999, 2000, 2000.5, Infinity, NaN, 5_000_001])
      expect(() => usageIntentAction(usage, "personal", amount)).toThrow("limit_must_increase");
    expect(() => usageIntentAction({ ...usage, orgExtraLimitCents: null }, "organization", 50000)).toThrow("limit_must_increase");
  });
  test("decimal input is validated before converting money to cents", () => {
    expect(parseUsageAmount("30.50")).toBe(3050);
    expect(parseUsageAmount("30,50")).toBe(3050);
    for (const amount of [null, "-1", "30.555", "1e3", "50000.01"])
      expect(() => parseUsageAmount(amount)).toThrow();
  });
});
