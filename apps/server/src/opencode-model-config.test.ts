import { describe, expect, test } from "bun:test";
import { buildEigenweltModelsMap } from "./eigenwelt-auth.js";
import { parseManifestModels } from "./eigenwelt-paid-manifest.js";

describe("native OpenCode model configuration", () => {
  test("round-trips provider options, nested budgets, custom variant names and disabled entries", () => {
    const controls = { interleaved: { field: "reasoning_content" }, options: { thinking: { type: "adaptive" } }, variants: {
      high: { reasoningEffort: "high" }, adaptive: { thinking: { type: "adaptive" } },
      CustomBudget: { thinking: { budgetTokens: 4096 } }, medium: { disabled: true },
    } };
    const [model] = parseManifestModels([{ id: "future-provider", reasoning: true, ...controls }]);
    expect(model).toMatchObject(controls);
    expect(buildEigenweltModelsMap([model])[model.id]).toMatchObject(controls);
    expect(parseManifestModels(JSON.parse(JSON.stringify([model])))).toEqual([model]);
  });

  test("rejects malformed native configuration instead of inferring speculative controls", () => {
    expect(parseManifestModels([
      { id: "bad-options", options: "high" }, { id: "bad-variants", variants: [] },
      { id: "bad-disabled", variants: { high: { disabled: "yes" } } },
      { id: "bad-effort", variants: { high: "high" } },
    ])).toEqual([]);
  });

  test("older manifests retain their existing inference without client model knowledge", () => {
    const [model] = parseManifestModels([{ id: "old", reasoning: true }]);
    expect(buildEigenweltModelsMap([model]).old).not.toHaveProperty("variants");
    expect(buildEigenweltModelsMap([model]).old).not.toHaveProperty("options");
  });
});
