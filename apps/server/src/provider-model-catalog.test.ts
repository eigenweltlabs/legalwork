import { afterEach, expect, test } from "bun:test";
import { modelCatalogBaseURL, providerModelsFromCatalog } from "./provider-model-catalog.js";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

const originalEnv = {
  OPENCODE_MODELS_URL: process.env.OPENCODE_MODELS_URL,
  LEGALWORK_DEV_MODE: process.env.LEGALWORK_DEV_MODE,
};
afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("uses Eigenwelt's catalog in production and standalone development", () => {
  delete process.env.OPENCODE_MODELS_URL;
  delete process.env.LEGALWORK_DEV_MODE;
  expect(modelCatalogBaseURL()).toBe("https://platform.eigenweltlabs.com/api/public/model-catalog");
  process.env.LEGALWORK_DEV_MODE = "1";
  expect(modelCatalogBaseURL()).toBe("https://platform.eigenweltlabs.com/api/public/model-catalog");
});

test("keeps explicit catalog overrides and normalizes their URLs", () => {
  process.env.LEGALWORK_DEV_MODE = "1";
  process.env.OPENCODE_MODELS_URL = "  http://localhost:8791/models///  ";
  expect(modelCatalogBaseURL()).toBe("http://localhost:8791/models");
});

test("uses Eigenwelt's catalog when the override is blank", () => {
  process.env.OPENCODE_MODELS_URL = "   ";
  expect(modelCatalogBaseURL()).toBe("https://platform.eigenweltlabs.com/api/public/model-catalog");
});

test("rejects third-party overrides, credentials, queries, and insecure remote URLs", () => {
  for (const url of ["https://models.opencode.ai", "https://platform.eigenweltlabs.com.other.example", "http://platform.eigenweltlabs.com", "https://user:secret@platform.eigenweltlabs.com", "https://platform.eigenweltlabs.com/?user=123"]) {
    process.env.OPENCODE_MODELS_URL = url;
    expect(modelCatalogBaseURL).toThrow();
  }
});

test("keeps catalog capabilities and token limits without importing unrelated providers", () => {
  const details = { name: "New reasoning model", reasoning: true, tool_call: true, attachment: true,
    limit: { context: 200000, output: 64000 }, cost: { input: 2, output: 8 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] } } satisfies NonNullable<ProviderConfig["models"]>[string];
  expect(providerModelsFromCatalog("anthropic", { anthropic: { models: { "model-1": { ...details, knowledge: "2026-09" } } }, unrelated: { models: "invalid" } })).toEqual({ "model-1": details });
});

test("reports malformed or missing provider information", () => {
  for (const value of [[], {}, { anthropic: { models: { broken: { name: "Missing limits" } } } }]) {
    expect(() => providerModelsFromCatalog("anthropic", value)).toThrow();
  }
});
