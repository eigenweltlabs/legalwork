import { describe, expect, test } from "bun:test";
import en from "../src/i18n/locales/en";
import de from "../src/i18n/locales/de";
import {
  usageBlockMessageKey,
  usageBlockNeedsSettings,
} from "../src/react-app/domains/connections/usage-control/usage-block";

describe("managed AI usage recovery", () => {
  test.each(["member_limit", "organization_limit", "extra_disabled"])(
    "%s needs spending controls rather than a top-up",
    (reason) => {
      expect(usageBlockNeedsSettings(reason)).toBe(true);
      const admin = en[usageBlockMessageKey(reason, true)];
      const member = en[usageBlockMessageKey(reason, false)];
      expect(member).toContain("Ask your admin");
      if (reason !== "extra_disabled") {
        expect(admin).toContain("Adding credits does not raise");
        expect(member).not.toContain("add credits");
      }
    },
  );
  test("only an empty wallet is resolved by funding the shared balance", () => {
    expect(usageBlockNeedsSettings("wallet_empty")).toBe(false);
    expect(en[usageBlockMessageKey("wallet_empty", true)])
      .toContain("Add credits to continue within your personal and team spending limits");
    expect(en[usageBlockMessageKey("wallet_empty", false)])
      .toContain("Ask your admin to add credits");
  });
  test("all blocking reasons have administrator and member translations", () => {
    for (const reason of ["member_limit", "organization_limit", "wallet_empty", "extra_disabled", "seat_required"]) {
      for (const admin of [true, false]) {
        const key = usageBlockMessageKey(reason, admin);
        expect(en[key]).toBeTruthy();
        expect(de[key]).toBeTruthy();
      }
    }
    expect(usageBlockMessageKey("unknown", true)).toBe("limits.blocked");
  });
});
