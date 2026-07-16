import { describe, expect, test } from "bun:test";

import {
  EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT,
  EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS,
  consumeEigenweltBudgetStop,
  eigenweltBudgetLimitDisplay,
  eigenweltBudgetRetryAction,
  isEigenweltBudgetError,
  isEigenweltBudgetExceededErrorText,
  markEigenweltBudgetStop,
  shouldStopEigenweltBudgetRetry,
} from "../src/app/lib/eigenwelt-budget";

const BUDGET_MESSAGE =
  "Budget has been exceeded! Team=org_3GJdAyS6A3LDipvEZoGsVakFq8G Current cost: 0.062, Max budget: 0.06";

describe("isEigenweltBudgetError", () => {
  test("matches only the eigenwelt provider with a budget message", () => {
    expect(isEigenweltBudgetError("eigenwelt", BUDGET_MESSAGE)).toBe(true);
    expect(isEigenweltBudgetError("eigenwelt", "budget has been exceeded")).toBe(true);
  });

  test("never matches other providers — their retry behavior is untouched", () => {
    expect(isEigenweltBudgetError("anthropic", BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltBudgetError("openai", BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltBudgetError(null, BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltBudgetError(undefined, BUDGET_MESSAGE)).toBe(false);
  });

  test("never matches other error kinds for eigenwelt", () => {
    expect(isEigenweltBudgetError("eigenwelt", "Rate limit exceeded")).toBe(false);
    expect(isEigenweltBudgetError("eigenwelt", "connection reset")).toBe(false);
    expect(isEigenweltBudgetError("eigenwelt", null)).toBe(false);
    expect(isEigenweltBudgetError("eigenwelt", "")).toBe(false);
  });
});

describe("shouldStopEigenweltBudgetRetry", () => {
  test("allows exactly the configured attempts, then stops", () => {
    for (let attempt = 1; attempt < EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS; attempt++) {
      expect(shouldStopEigenweltBudgetRetry("eigenwelt", BUDGET_MESSAGE, attempt)).toBe(false);
    }
    expect(
      shouldStopEigenweltBudgetRetry("eigenwelt", BUDGET_MESSAGE, EIGENWELT_BUDGET_MAX_RETRY_ATTEMPTS),
    ).toBe(true);
    expect(shouldStopEigenweltBudgetRetry("eigenwelt", BUDGET_MESSAGE, 5)).toBe(true);
  });

  test("never stops other providers regardless of attempts", () => {
    expect(shouldStopEigenweltBudgetRetry("anthropic", BUDGET_MESSAGE, 99)).toBe(false);
    expect(shouldStopEigenweltBudgetRetry("eigenwelt", "some other error", 99)).toBe(false);
  });
});

describe("terminal error text", () => {
  test("round-trips through the matcher", () => {
    expect(isEigenweltBudgetExceededErrorText(EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT)).toBe(true);
  });

  test("does not match the raw gateway error or unrelated errors", () => {
    expect(isEigenweltBudgetExceededErrorText(BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltBudgetExceededErrorText("The message was interrupted")).toBe(false);
    expect(isEigenweltBudgetExceededErrorText(null)).toBe(false);
  });
});

describe("retry banner action", () => {
  test("defaults to the prod billing page when no platform is connected", () => {
    const action = eigenweltBudgetRetryAction();
    expect(action.link).toBe("https://platform.eigenweltlabs.com/billing");
    expect(action.provider).toBe("eigenwelt");
    expect(action.label).toBe("Upgrade to Pro");
    expect(action.message).toBe("Upgrade to Pro for higher limits, or come back tomorrow.");
  });

  test("uses the connected platform's billing URL when provided", () => {
    const action = eigenweltBudgetRetryAction("https://acme.example.com/billing");
    expect(action.link).toBe("https://acme.example.com/billing");
  });
});

describe("plan-aware limit display", () => {
  test("offers Plus users an upgrade to Pro", () => {
    expect(eigenweltBudgetLimitDisplay("plus")).toEqual({
      title: "Your seat's daily usage has been used up",
      body: "Upgrade to Pro for higher limits, or come back tomorrow.",
      upgradeLabel: "Upgrade to Pro",
    });
  });

  test("shows Pro users the reached limit without an upgrade", () => {
    expect(eigenweltBudgetLimitDisplay("pro")).toEqual({
      title: "Daily usage limit reached",
      body: "You've used today's Pro allowance. Come back tomorrow.",
      upgradeLabel: null,
    });
  });
});

describe("pending-stop registry", () => {
  test("consume is single-use", () => {
    markEigenweltBudgetStop("ses_a");
    expect(consumeEigenweltBudgetStop("ses_a")).toBe(true);
    expect(consumeEigenweltBudgetStop("ses_a")).toBe(false);
  });

  test("unmarked sessions never consume", () => {
    expect(consumeEigenweltBudgetStop("ses_never")).toBe(false);
  });

  test("marks expire after the TTL", () => {
    const t0 = 1_000_000;
    markEigenweltBudgetStop("ses_b", t0);
    expect(consumeEigenweltBudgetStop("ses_b", t0 + 61_000)).toBe(false);
  });

  test("marks within the TTL are honored", () => {
    const t0 = 2_000_000;
    markEigenweltBudgetStop("ses_c", t0);
    expect(consumeEigenweltBudgetStop("ses_c", t0 + 59_000)).toBe(true);
  });
});
