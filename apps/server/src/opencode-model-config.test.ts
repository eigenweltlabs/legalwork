import { describe, expect, test } from "bun:test";
import { buildEigenweltModelsMap } from "./eigenwelt-auth.js";
import { parseManifestModels, buildEigenweltPaidProviderBlock } from "./eigenwelt-paid-manifest.js";

describe("native OpenCode model configuration", () => {
  test("keeps the gateway manifest contract and builds native controls without a legacy configuration converter", () => {
    const controls = { interleaved: { field: "reasoning_content" }, options: { thinking: { type: "adaptive" } }, variants: {
      high: { reasoningEffort: "high" }, adaptive: { thinking: { type: "adaptive" } },
      CustomBudget: { thinking: { budgetTokens: 4096 } }, medium: { disabled: true },
    } };
    const [model] = parseManifestModels([{ id: "future-provider", reasoning: true, ...controls }]);
    if (!model) throw new Error("Gateway controls were rejected");
    expect(model).toMatchObject(controls);
    expect(buildEigenweltModelsMap([model])[model.id]).toMatchObject({
      compatibility: { reasoningField: "reasoning_content" }, body: { thinking: { type: "adaptive" } },
      capabilities: { reasoning: { supported: true } },
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }, { id: "adaptive", body: { thinking: { type: "adaptive" } } }, { id: "CustomBudget", body: { thinking: { budgetTokens: 4096 } } }],
    });
    expect(parseManifestModels(JSON.parse(JSON.stringify([model])))).toEqual([model]);
  });
  test("rejects malformed gateway controls instead of inferring speculative settings", () => {
    expect(parseManifestModels([
      { id: "bad-options", options: "high" }, { id: "bad-variants", variants: [] },
      { id: "bad-disabled", variants: { high: { disabled: "yes" } } },
      { id: "bad-effort", variants: { high: "high" } },
    ])).toEqual([]);
  });
  test("older manifests retain native defaults without forced generation parameters", () => {
    const [model] = parseManifestModels([{ id: "old", reasoning: true }]);
    if (!model) throw new Error("Older manifest model was rejected");
    const native = buildEigenweltModelsMap([model]).old;
    expect(native).not.toHaveProperty("variants");
    expect(native).not.toHaveProperty("options");
    expect(native?.body).not.toHaveProperty("temperature");
    expect(native?.settings).not.toHaveProperty("temperature");
  });
  test("gateway compatibility controls stay in native compatibility instead of leaking into the provider body", () => {
    const source = { id: "model", options: { setCacheKey: true, thinking: { type: "adaptive", blockBinding: false } } };
    const original = JSON.stringify(source);
    expect(buildEigenweltModelsMap([source]).model).toMatchObject({
      compatibility: { supportsPromptCacheKey: true, supportsThinkingBlockBinding: false }, body: { thinking: { type: "adaptive" } },
    });
    expect(buildEigenweltModelsMap([source]).model?.body).not.toHaveProperty("setCacheKey");
    expect(JSON.stringify(source)).toBe(original);
  });
  test("paid Eigenwelt provider uses the native driver and private headers", () => {
    const block = buildEigenweltPaidProviderBlock({ baseURL: "http://127.0.0.1:7/v1", apiKey: "synthetic", models: [{ id: "model", toolCall: true }] });
    expect(block).toMatchObject({ package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:7/v1" }, headers: { Authorization: "Bearer synthetic" }, models: { model: { capabilities: { tools: true } } } });
    expect(block).not.toHaveProperty("npm"); expect(block).not.toHaveProperty("options");
  });
});
