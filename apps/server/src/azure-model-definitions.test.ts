import { expect, test } from "bun:test";
import { azureModelDefinitions } from "./azure-model-definitions.js";

const mini = {
  id: "gpt-4.1-mini", name: "GPT-4.1 mini", status: "deprecated", family: "gpt-mini", release_date: "2025-04-14",
  tool_call: true, temperature: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  limit: { context: 1047576, output: 32768 }, cost: { input: 0.4, output: 1.6, cache_read: 0.1 },
};

test("Azure definitions retain deprecated metadata without changing the public catalog", () => {
  const catalog = { azure: { models: { "gpt-4.1-mini": structuredClone(mini) } } };
  const before = structuredClone(catalog);
  const [model] = azureModelDefinitions(catalog);
  expect(model).toMatchObject({ id: mini.id, modelID: mini.id, providerID: "azure", name: mini.name,
    status: "deprecated", enabled: true, limit: mini.limit, family: "gpt-mini",
    capabilities: { tools: true, temperature: true, input: ["text", "image", "pdf"], output: ["text"] },
    cost: [{ input: 0.4, output: 1.6, cache: { read: 0.1, write: 0 } }], time: { released: Date.parse(mini.release_date) } });
  expect(model).not.toHaveProperty("package"); // Inherit the native Azure package.
  expect(catalog).toEqual(before);
});

test("only missing deprecated text templates need compatibility definitions; bad entries are isolated", () => {
  expect(azureModelDefinitions({ azure: { models: {
    active: { ...mini, status: "active" }, image: { ...mini, modalities: { input: ["text"], output: ["image"] } },
    corrupt: { ...mini, limit: { context: "unknown" } }, kept: mini,
    unknown: { ...mini, provider: { npm: "unknown-sdk" } },
  } }, openai: { models: { other: mini } } }).map(model => String(model.id))).toEqual([mini.id]);
  for (const value of [null, {}, { azure: { models: null } }]) expect(azureModelDefinitions(value)).toEqual([]);
});

test("per-model native routes, reasoning, compatibility, and tiered pricing survive", () => {
  const [model] = azureModelDefinitions({ azure: { models: { reasoning: {
    ...mini, id: "reasoning", provider: { npm: "@ai-sdk/openai-compatible", api: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/models" },
    interleaved: { field: "reasoning_content" }, reasoning_options: [{ type: "effort", values: [null, "null", "low", "high"] }],
    cost: { input: 1, output: 2, cache_read: 0.2, tiers: [{ tier: { type: "context", size: 200000 }, input: 3, output: 4, cache_read: 0.3 }] },
  } } } });
  expect(model).toMatchObject({ package: "@opencode/ai/providers/openai-compatible",
    settings: { provider: "azure", baseURL: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/models" },
    compatibility: { reasoningField: "reasoning_content" }, variants: [
      { id: "low", settings: { reasoningEffort: "low" } }, { id: "high", settings: { reasoningEffort: "high" } },
    ], cost: [{ input: 1, output: 2, cache: { read: 0.2, write: 0 } },
      { tier: { type: "context", size: 200000 }, input: 3, output: 4, cache: { read: 0.3, write: 0 } }] });
});

test("an explicit Azure chat route does not become Responses", () => {
  expect(azureModelDefinitions({ azure: { models: { chat: { ...mini, provider: { npm: "@ai-sdk/azure", shape: "completions" } } } } })[0]?.package)
    .toBe("@opencode/ai/providers/azure/chat");
});
