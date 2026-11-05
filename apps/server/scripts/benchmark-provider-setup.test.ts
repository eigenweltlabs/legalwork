import { expect, test } from "bun:test";
import { nativeProvider } from "../src/native-opencode-config";
import { buildEigenweltModelsMap } from "../src/eigenwelt-auth";
import { benchmarkProviderConfiguration } from "../../../scripts/benchmarks/setup-provider.mjs";

test("benchmark provider preparation preserves native production limits, modalities and generation variants", () => {
  const modelID = "Synthetic gateway alias";
  const models = buildEigenweltModelsMap([{ id: modelID, contextLength: 1_048_576, maxOutputTokens: 65_536,
    reasoning: true, toolCall: true, inputModalities: ["text", "image", "pdf"],
    options: { reasoning_effort: "high", parallel_tool_calls: true },
    variants: { default: { reasoning_effort: "high" }, deep: { reasoning_effort: "max", temperature: 0.4 } },
  }]);
  const input = { modelID, model: models[modelID], capture: { baseURL: "http://127.0.0.1:9000", localToken: "fixture-local-only" } };
  const before = structuredClone(models);
  const result = benchmarkProviderConfiguration({ ...input, migrateProvider: nativeProvider });
  expect(models).toEqual(before);
  expect(result.opencode).not.toHaveProperty("provider");
  expect(result.opencode).not.toHaveProperty("agent");
  expect(result.opencode.agents.legalwork.model).toBe(`benchmark/${modelID}`);
  const provider = result.opencode.providers.benchmark;
  expect(provider.package).toBe("@opencode/ai/providers/openai-compatible");
  expect(provider.settings).toEqual({ baseURL: "http://127.0.0.1:9000/v1", apiKey: "fixture-local-only" });
  expect(provider.models[modelID]).toEqual(nativeProvider({ npm: "@ai-sdk/openai-compatible", models }).models[modelID]);
  expect(provider.models[modelID].limit).toEqual({ context: 1_048_576, output: 65_536 });
  expect(provider.models[modelID].body).toEqual({ reasoning_effort: "high", parallel_tool_calls: true });
  expect(provider.models[modelID].capabilities).toEqual({ tools: true, input: ["text", "image", "pdf"], output: ["text"] });
  expect(provider.models[modelID].variants).toEqual([{ id: "default", settings: {}, body: { reasoning_effort: "high" } }, { id: "deep", settings: {}, body: { reasoning_effort: "max", temperature: 0.4 } }]);
  const legacy = benchmarkProviderConfiguration(input);
  expect(legacy.opencode.provider.benchmark.models).toEqual(models);
  expect(legacy.opencode.agent.legalwork.model).toBe(`benchmark/${modelID}`);
});
