import { describe, expect, test } from "bun:test";

import {
  EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT,
  consumeProviderUsageLimitStop,
  eigenweltBudgetLimitDisplay,
  isEigenweltBudgetError,
  isEigenweltBudgetExceededErrorText,
  markEigenweltBudgetStop,
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

describe("standalone legacy limit display", () => {
  test("links standalone legacy errors to billing", () => {
    const expected = {
      title: "Your seat's included usage for this week is used up",
      body: "It resets next week. Your firm's billing shows this week's usage in detail.",
      upgradeLabel: "Open Billing",
    };
    expect(eigenweltBudgetLimitDisplay("plus")).toEqual(expected);
    // Saved legacy payloads use the same standalone fallback.
    expect(eigenweltBudgetLimitDisplay("pro")).toEqual(expected);
    expect(eigenweltBudgetLimitDisplay(null)).toEqual(expected);
  });
});

describe("pending-stop registry", () => {
  test("consume is single-use", () => {
    markEigenweltBudgetStop("ses_a");
    expect(consumeProviderUsageLimitStop("ses_a")).toBe(EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT);
    expect(consumeProviderUsageLimitStop("ses_a")).toBeNull();
  });

  test("unmarked sessions never consume", () => {
    expect(consumeProviderUsageLimitStop("ses_never")).toBeNull();
  });

  test("marks expire after the TTL", () => {
    const t0 = 1_000_000;
    markEigenweltBudgetStop("ses_b", t0);
    expect(consumeProviderUsageLimitStop("ses_b", t0 + 61_000)).toBeNull();
  });

  test("marks within the TTL are honored", () => {
    const t0 = 2_000_000;
    markEigenweltBudgetStop("ses_c", t0);
    expect(consumeProviderUsageLimitStop("ses_c", t0 + 59_000)).toBe(EIGENWELT_BUDGET_EXCEEDED_ERROR_TEXT);
  });
});
