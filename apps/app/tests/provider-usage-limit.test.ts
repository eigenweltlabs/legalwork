import { describe, expect, test } from "bun:test";
import {
  isProviderUsageLimitError,
  providerFromUsageLimitError,
  providerUsageLimitErrorText,
  usageLimitOptions,
} from "../src/app/lib/provider-usage-limit";
import {
  consumeProviderUsageLimitStop,
  markEigenweltBudgetStop,
  updateProviderUsageLimitStop,
} from "../src/app/lib/eigenwelt-budget";

describe("provider quota recovery", () => {
  test("recognizes funding and subscription limits without treating throttling as exhausted usage", () => {
    for (const error of [
      "Budget has been exceeded. Request more usage from your admin.",
      "insufficient_quota",
      "Your credit balance is too low to access the Anthropic API",
      "Your account or API key has insufficient credits.",
      "insufficient_credits",
      "You've hit your usage limit",
      "subscription_sharing_usage_limit_exceeded",
      "subscription_sharing_usage_unavailable",
      "usage_limit_reached",
      "You exceeded your current quota, please check your plan and billing details.",
    ])
      expect(isProviderUsageLimitError(error)).toBe(true);
    for (const error of [
      "Rate limit exceeded",
      "rate_limit_exceeded",
      "Too many requests. Retry in 20 seconds.",
      "HTTP 429",
      "RESOURCE_EXHAUSTED: Rate limit exceeded",
      "Quota exceeded for metric requests_per_minute",
      "Context length exceeded",
      "Connection reset",
      "Invalid API key",
      null,
    ])
      expect(isProviderUsageLimitError(error)).toBe(false);
  });
  test("Free offers only AI plans; paid plans also offer top-ups", () => {
    expect(usageLimitOptions(null)).toEqual({
      plans: ["plus", "pro"],
      topUp: false,
    });
    expect(usageLimitOptions("sync")).toEqual({
      plans: ["plus", "pro"],
      topUp: true,
    });
    expect(usageLimitOptions("plus")).toEqual({ plans: ["pro"], topUp: true });
    expect(usageLimitOptions("pro")).toEqual({ plans: [], topUp: true });
  });
  test("the stopped turn retains provider identity after its generic abort event", () => {
    const text = providerUsageLimitErrorText("openai");
    markEigenweltBudgetStop("quota-turn", 100, text);
    expect(consumeProviderUsageLimitStop("quota-turn", 101)).toBe(text);
    expect(providerFromUsageLimitError(text)).toBe("openai");
    expect(consumeProviderUsageLimitStop("quota-turn", 102)).toBeNull();
    updateProviderUsageLimitStop("quota-turn", text);
    expect(consumeProviderUsageLimitStop("quota-turn", 103)).toBeNull();
    expect(providerFromUsageLimitError("Unrelated provider error")).toBeNull();
  });
  test("quota recovery retains the originating provider for built-in and custom providers", () => {
    for (const provider of ["openai", "anthropic", "google", "openrouter", "custom-provider"]) {
      expect(providerFromUsageLimitError(providerUsageLimitErrorText(provider))).toBe(provider);
    }
  });
});
