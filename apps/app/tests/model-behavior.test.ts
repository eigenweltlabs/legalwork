import { describe, expect, test } from "bun:test";
import type { Model } from "@opencode-ai/sdk/v2/client";
import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "../src/app/lib/model-behavior";

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

describe("model-specific reasoning", () => {
  test("binary models expose on/off and default to the catalog's enabled mode", () => {
    const summary = getModelBehaviorSummary("eigenwelt", model(["none", "high"], "high"), null);
    expect(summary.value).toBe("high");
    expect(summary.options.filter((option) => option.value).map((option) => [option.value, option.label]))
      .toEqual([["none", "Reasoning off"], ["high", "Reasoning on"]]);
  });

  test.each(["low", "medium"])("reopening a saved %s choice enables real binary reasoning", (saved) => {
    const binary = model(["none", "high"], "high");
    expect(sanitizeModelBehaviorValue("eigenwelt", binary, saved)).toBe("high");
    expect(getModelBehaviorSummary("eigenwelt", binary, saved).value).toBe("high");
  });

  test("off remains off, and a catalog default of off is respected", () => {
    const binary = model(["none", "high"], "none");
    expect(getModelBehaviorSummary("eigenwelt", binary, "none").value).toBe("none");
    expect(getModelBehaviorSummary("eigenwelt", binary, null).value).toBe("none");
  });

  test("switching models cannot forward an unsupported saved effort", () => {
    const levels = model(["low", "medium", "high"], "medium");
    expect(sanitizeModelBehaviorValue("eigenwelt", levels, "none")).toBeNull();
    expect(getModelBehaviorSummary("eigenwelt", levels, "none").value).toBe("medium");
    for (const effort of ["low", "medium", "high"]) {
      expect(getModelBehaviorSummary("eigenwelt", levels, effort).value).toBe(effort);
    }
  });

  test("built-in reasoning has no selectable efforts or outgoing variant", () => {
    const summary = getModelBehaviorSummary("eigenwelt", model([]), "medium");
    expect(summary.options).toEqual([]);
    expect(summary.value).toBeNull();
  });

  test("older and custom providers keep their variant defaults", () => {
    expect(getModelBehaviorSummary("custom", model(["low", "medium", "high"]), null).value).toBe("medium");
  });
});
