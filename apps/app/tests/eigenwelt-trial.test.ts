import { describe, expect, test } from "bun:test";

import { eigenweltTrialState, isEigenweltEntitledStatus } from "../src/app/lib/eigenwelt-trial";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe("eigenweltTrialState", () => {
  test("no entitlements or no trial on record -> none", () => {
    expect(eigenweltTrialState(null, NOW).kind).toBe("none");
    expect(eigenweltTrialState(undefined, NOW).kind).toBe("none");
    expect(
      eigenweltTrialState({ subscriptionStatus: "active", trialEndsAt: null }, NOW).kind,
    ).toBe("none");
    expect(eigenweltTrialState({ subscriptionStatus: "trialing" }, NOW).kind).toBe("none");
  });

  test("malformed trialEndsAt -> none", () => {
    expect(
      eigenweltTrialState({ subscriptionStatus: "trialing", trialEndsAt: "soon" }, NOW).kind,
    ).toBe("none");
  });

  test("trialing -> active with ceil'd days left", () => {
    const state = eigenweltTrialState(
      { subscriptionStatus: "trialing", trialEndsAt: inDays(6.5) },
      NOW,
    );
    expect(state).toEqual({ kind: "active", endsAt: new Date(inDays(6.5)), daysLeft: 7 });
  });

  test("trialing just past the end (webhook lag) clamps to 0, not negative", () => {
    const state = eigenweltTrialState(
      { subscriptionStatus: "trialing", trialEndsAt: inDays(-0.1) },
      NOW,
    );
    expect(state.kind).toBe("active");
    if (state.kind === "active") expect(state.daysLeft).toBe(0);
  });

  test("converted to a paid subscription -> none", () => {
    for (const status of ["active", "past_due"]) {
      expect(
        eigenweltTrialState({ subscriptionStatus: status, trialEndsAt: inDays(-3) }, NOW).kind,
      ).toBe("none");
    }
  });

  test("entitled statuses gate plan displays; lapsed ones do not", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(isEigenweltEntitledStatus(status)).toBe(true);
    }
    for (const status of ["canceled", "unpaid", "incomplete_expired", null, undefined]) {
      expect(isEigenweltEntitledStatus(status)).toBe(false);
    }
  });

  test("lapsed after a trial -> ended (canceled during the trial included)", () => {
    const past = eigenweltTrialState(
      { subscriptionStatus: "canceled", trialEndsAt: inDays(-3) },
      NOW,
    );
    expect(past).toEqual({ kind: "ended", endedAt: new Date(inDays(-3)) });
    // Canceled immediately mid-trial: access is gone even though the end date
    // is still ahead — the subscribe prompt must show.
    expect(
      eigenweltTrialState({ subscriptionStatus: "canceled", trialEndsAt: inDays(2) }, NOW).kind,
    ).toBe("ended");
    expect(
      eigenweltTrialState({ subscriptionStatus: null, trialEndsAt: inDays(-3) }, NOW).kind,
    ).toBe("ended");
  });
});
