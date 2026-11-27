import { describe, expect, test } from "bun:test";
import { validateRuntimeProviders } from "./runtime-provider-validation.js";
import { nativeProviderDefinition } from "./opencode-model-config.js";

const nativeProvider = { package: "@opencode/ai/providers/openai-compatible", name: "Local gateway", settings: { baseURL: "http://localhost:11434/v1" }, models: { model: { name: "Model", limit: { context: 8192, output: 4096 } } } };

describe("native provider validation", () => {
  test("keeps every valid connection, including ids LegalWork once owned", () => {
    expect(validateRuntimeProviders({ "eigenwelt-free": nativeProvider, local: nativeProvider })).toEqual({ "eigenwelt-free": nativeProvider, local: nativeProvider });
  });
  test("preserves native model-only overrides, optional limits, capability flags and variant arrays", () => {
    const provider = nativeProviderDefinition({ models: { model: { limit: { context: 128_000 }, capabilities: { temperature: false, reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] }, output: { limit: { output: 96_000 } } } });
    expect(validateRuntimeProviders({ openai: provider })).toEqual({ openai: provider });
  });
  test("malformed native connections fail closed without removing or mutating their source", () => {
    for (const provider of ["not a block", { models: { model: "invalid" } }, { models: { model: { cost: { input: 1 } } } }, { models: { model: { capabilities: { input: [123] } } } }]) {
      const original = JSON.stringify(provider);
      expect(() => validateRuntimeProviders({ private: provider })).toThrow("has not removed the connection");
      expect(JSON.stringify(provider)).toBe(original);
    }
  });
  test("legacy provider syntax is rejected at runtime instead of guessed or silently converted", () => {
    expect(() => validateRuntimeProviders({ legacy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:7" } } })).toThrow("invalid native settings");
  });
});
