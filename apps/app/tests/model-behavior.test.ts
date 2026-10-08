import { describe, expect, test } from "bun:test";
import type { Model } from "@opencode-ai/sdk/v2/client";
import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "../src/app/lib/model-behavior";
import { parseSessionChoiceOverrides, parseWorkspaceModelVariants, serializeSessionChoiceOverrides } from "../src/react-app/kernel/model-config";

function model(efforts: string[], defaultEffort?: string): Model {
  const modalities = { text: true, audio: false, image: false, video: false, pdf: false };
  return {
    id: "test", providerID: "eigenwelt", name: "Test",
    api: { id: "test", url: "http://127.0.0.1/v1", npm: "@ai-sdk/openai-compatible" },
    capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true,
      input: modalities, output: modalities, interleaved: false },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_000 }, status: "active", headers: {}, release_date: "",
    options: defaultEffort ? { reasoningEffort: defaultEffort } : {},
    variants: Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
  };
}

describe("catalog variants", () => {
  test("shows literal native names, including distinct xhigh and max", () => {
    const summary = getModelBehaviorSummary("eigenwelt", model(["none", "low", "medium", "high", "xhigh", "max"]), null);
    expect(summary.value).toBeNull();
    expect(summary.options.filter((option) => option.value).map((option) => [option.value, option.label]))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"].map((key) => [key, key]));
  });

  test.each(["low", "medium"])("an unsupported saved %s returns to provider default without guessing a replacement", (saved) => {
    const binary = model(["none", "high"]);
    expect(sanitizeModelBehaviorValue("eigenwelt", binary, saved)).toBeNull();
    expect(getModelBehaviorSummary("eigenwelt", binary, saved).value).toBeNull();
  });

  test.each(["none", "high", "max"])("displays native default %s without an extra dropdown item or variant override", (effort) => {
    const summary = getModelBehaviorSummary("custom", model(["none", "high", "max"], effort), null);
    expect(summary.label).toBe(effort);
    expect(summary.value).toBeNull();
    expect(summary.options.map((option) => option.value)).toEqual(["none", "high", "max"]);
    expect(summary.options.filter((option) => option.isDefault).map((option) => option.value)).toEqual([effort]);
  });

  test("does not invent a default when metadata is absent or a variant adds settings", () => {
    const unconfigured = getModelBehaviorSummary("custom", model(["low", "medium", "high"]), null);
    expect(unconfigured.value).toBeNull();
    expect(unconfigured.options.some((option) => option.label === unconfigured.label)).toBe(false);
    const configured = model(["low", "high"], "high");
    configured.variants = { high: { reasoningEffort: "high", custom: { budget: 42 } }, low: { reasoningEffort: "low" } };
    const summary = getModelBehaviorSummary("custom", configured, null);
    expect(summary.value).toBeNull();
    expect(summary.label).not.toBe("high");
    expect(getModelBehaviorSummary("custom", configured, "high").value).toBe("high");
  });

  test("unsupported saved choices display the configured native default", () => {
    const summary = getModelBehaviorSummary("custom", model(["none", "high"], "high"), "medium");
    expect(summary.label).toBe("high");
    expect(summary.value).toBeNull();
  });

  test("custom catalog keys preserve their case and options", () => {
    const custom = model(["CustomBudget", "adaptive", "balanced"]);
    for (const key of ["CustomBudget", "adaptive", "balanced"]) {
      expect(getModelBehaviorSummary("custom", custom, key).value).toBe(key);
    }
    expect(sanitizeModelBehaviorValue("custom", custom, "custombudget")).toBe("CustomBudget");
  });

  test("saved session and workspace choices preserve literal keys, including former default sentinels", () => {
    const keys = ["CustomBudget", "balanced", "default", "provider-default"];
    const custom = model(keys);
    for (const key of keys) {
      const saved = serializeSessionChoiceOverrides({ session: { variant: key } });
      const restored = parseSessionChoiceOverrides(saved).session.variant ?? null;
      expect(restored).toBe(key);
      expect(getModelBehaviorSummary("custom", custom, restored).value).toBe(key);
      expect(parseWorkspaceModelVariants(JSON.stringify({ "custom/model": key }))["custom/model"]).toBe(key);
    }
  });

  test("GLM exposes low/high/max without a medium or off choice", () => {
    const summary = getModelBehaviorSummary("eigenwelt", model(["low", "high", "max"]), "medium");
    expect(summary.value).toBeNull();
    expect(summary.options.map((option) => option.value)).toEqual(["low", "high", "max"]);
  });

  test("disabled variants cannot be selected and built-in reasoning still works", () => {
    const configured = model(["low", "high"]);
    configured.variants = { ...configured.variants, medium: { disabled: true } };
    expect(sanitizeModelBehaviorValue("custom", configured, "medium")).toBeNull();
    const summary = getModelBehaviorSummary("eigenwelt", model([]), "medium");
    expect(summary.options).toEqual([]);
    expect(summary.value).toBeNull();
  });
});
