import { describe, expect, test } from "bun:test";

import {
  EIGENWELT_FREE_BUDGET_MAX_RETRY_ATTEMPTS,
  EIGENWELT_FREE_LIMIT_ERROR_TEXT,
  consumeEigenweltFreeBudgetStop,
  eigenweltFreeBudgetRetryAction,
  isEigenweltFreeBudgetError,
  isEigenweltFreeLimitErrorText,
  markEigenweltFreeBudgetStop,
  shouldStopEigenweltFreeBudgetRetry,
} from "../src/app/lib/eigenwelt-free-budget";

const BUDGET_MESSAGE = "Budget has been exceeded! Current cost: 0.51, Max budget: 0.5";

describe("isEigenweltFreeBudgetError", () => {
  test("matches only the eigenwelt-free provider with a budget message", () => {
    expect(isEigenweltFreeBudgetError("eigenwelt-free", BUDGET_MESSAGE)).toBe(true);
    expect(isEigenweltFreeBudgetError("eigenwelt-free", "budget has been exceeded")).toBe(true);
  });

  test("never matches other providers — their retry behavior is untouched", () => {
    expect(isEigenweltFreeBudgetError("eigenwelt", BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltFreeBudgetError("anthropic", BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltFreeBudgetError("openai", BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltFreeBudgetError(null, BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltFreeBudgetError(undefined, BUDGET_MESSAGE)).toBe(false);
  });

  test("never matches other error kinds for eigenwelt-free", () => {
    expect(isEigenweltFreeBudgetError("eigenwelt-free", "Rate limit exceeded")).toBe(false);
    expect(isEigenweltFreeBudgetError("eigenwelt-free", "connection reset")).toBe(false);
    expect(isEigenweltFreeBudgetError("eigenwelt-free", null)).toBe(false);
    expect(isEigenweltFreeBudgetError("eigenwelt-free", "")).toBe(false);
  });
});

describe("shouldStopEigenweltFreeBudgetRetry", () => {
  test("allows exactly the configured attempts, then stops", () => {
    for (let attempt = 1; attempt < EIGENWELT_FREE_BUDGET_MAX_RETRY_ATTEMPTS; attempt++) {
      expect(shouldStopEigenweltFreeBudgetRetry("eigenwelt-free", BUDGET_MESSAGE, attempt)).toBe(false);
    }
    expect(
      shouldStopEigenweltFreeBudgetRetry("eigenwelt-free", BUDGET_MESSAGE, EIGENWELT_FREE_BUDGET_MAX_RETRY_ATTEMPTS),
    ).toBe(true);
    expect(shouldStopEigenweltFreeBudgetRetry("eigenwelt-free", BUDGET_MESSAGE, 5)).toBe(true);
  });

  test("never stops other providers regardless of attempts", () => {
    expect(shouldStopEigenweltFreeBudgetRetry("eigenwelt", BUDGET_MESSAGE, 99)).toBe(false);
    expect(shouldStopEigenweltFreeBudgetRetry("anthropic", BUDGET_MESSAGE, 99)).toBe(false);
    expect(shouldStopEigenweltFreeBudgetRetry("eigenwelt-free", "some other error", 99)).toBe(false);
  });
});

describe("terminal error text", () => {
  test("round-trips through the matcher", () => {
    expect(isEigenweltFreeLimitErrorText(EIGENWELT_FREE_LIMIT_ERROR_TEXT)).toBe(true);
  });

  test("does not match the raw gateway error or unrelated errors", () => {
    expect(isEigenweltFreeLimitErrorText(BUDGET_MESSAGE)).toBe(false);
    expect(isEigenweltFreeLimitErrorText("The message was interrupted")).toBe(false);
    expect(isEigenweltFreeLimitErrorText(null)).toBe(false);
  });
});

describe("retry banner action", () => {
  test("points at the self-serve platform billing page", () => {
    const action = eigenweltFreeBudgetRetryAction();
    expect(action.link).toBe("https://platform.eigenweltlabs.com/billing");
    expect(action.provider).toBe("eigenwelt-free");
    expect(action.title).toBe("Out of free usage?");
    expect(action.label).toBe("Upgrade");
  });
});

describe("pending-stop registry", () => {
  test("consume is single-use", () => {
    markEigenweltFreeBudgetStop("ses_a");
    expect(consumeEigenweltFreeBudgetStop("ses_a")).toBe(true);
    expect(consumeEigenweltFreeBudgetStop("ses_a")).toBe(false);
  });

  test("unmarked sessions never consume", () => {
    expect(consumeEigenweltFreeBudgetStop("ses_never")).toBe(false);
  });

  test("marks expire after the TTL", () => {
    const t0 = 1_000_000;
    markEigenweltFreeBudgetStop("ses_b", t0);
    expect(consumeEigenweltFreeBudgetStop("ses_b", t0 + 61_000)).toBe(false);
  });

  test("marks within the TTL are honored", () => {
    const t0 = 2_000_000;
    markEigenweltFreeBudgetStop("ses_c", t0);
    expect(consumeEigenweltFreeBudgetStop("ses_c", t0 + 59_000)).toBe(true);
  });
});
