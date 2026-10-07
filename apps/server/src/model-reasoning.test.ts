import { describe, expect, test } from "bun:test";
import { buildEigenweltModelsMap } from "./eigenwelt-auth.js";
import { parseManifestModels } from "./eigenwelt-paid-manifest.js";
import { modelReasoningOptions, parseModelReasoningConfig, type ModelReasoningConfig } from "./model-reasoning.js";

describe("model reasoning contract", () => {
  test("keeps controls through the paid cache and engine config", () => {
    const [model] = parseManifestModels([{ id: "mistral", reasoning: true,
      reasoningConfig: { efforts: ["none", "high"], defaultEffort: "high" } }]);
    expect(model.reasoningConfig).toEqual({ efforts: ["none", "high"], defaultEffort: "high" });
    expect(buildEigenweltModelsMap([model]).mistral).toMatchObject({
      options: { reasoningEffort: "high" },
      variants: { none: { reasoningEffort: "none" }, high: { reasoningEffort: "high" },
        low: { disabled: true }, medium: { disabled: true } },
    });
  });

  test("covers every currently served model family in both regions", () => {
    const levels: ModelReasoningConfig = { efforts: ["low", "medium", "high"], defaultEffort: "medium" };
    const families: Array<[string, ModelReasoningConfig]> = [
      ["DeepSeek", levels], ["Gemini", levels], ["GPT Sol", levels], ["GPT Luna", levels],
      ["Claude Opus", levels], ["Claude Sonnet", levels], ["GLM", { efforts: [] }],
    ];
    for (const region of ["Europe", "US"]) for (const [family, reasoningConfig] of families) {
      const id = `Eigenwelt ${region} ${family}`;
      const parsed = parseManifestModels([{ id, reasoning: true, reasoningConfig }]);
      expect(parsed[0].reasoningConfig).toEqual(reasoningConfig);
      expect(buildEigenweltModelsMap(parsed)[id]).toMatchObject(modelReasoningOptions(reasoningConfig));
    }
  });

  test("built-in models explicitly disable inferred generic efforts", () => {
    expect(modelReasoningOptions({ efforts: [] })).toEqual({ variants: {
      none: { disabled: true }, minimal: { disabled: true }, low: { disabled: true },
      medium: { disabled: true }, high: { disabled: true }, xhigh: { disabled: true }, max: { disabled: true },
    } });
  });

  test("malformed controls cannot create speculative efforts or an invalid default", () => {
    expect(parseModelReasoningConfig({ efforts: ["none", "high", "extreme", "high"], defaultEffort: "medium" }))
      .toEqual({ efforts: ["none", "high"] });
    expect(parseModelReasoningConfig(null)).toEqual({ efforts: [] });
    expect(parseModelReasoningConfig({ efforts: "high" })).toEqual({ efforts: [] });
  });

  test("an older manifest leaves the existing engine inference untouched", () => {
    expect(modelReasoningOptions(undefined)).toEqual({});
    expect(parseManifestModels([{ id: "old", reasoning: true }])[0]).not.toHaveProperty("reasoningConfig");
  });
});
