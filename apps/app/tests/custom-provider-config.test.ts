import { describe, expect, test } from "bun:test";

import {
  customProviderModelEntry,
  customProviderModelFromEntry,
  findCustomModelLimitProblem,
  replaceDiscoveredModels,
} from "../src/react-app/domains/connections/provider-auth/custom-provider-config";

describe("custom provider model config", () => {
  test("a context override leaves output capacity to the native engine", () => {
    const entry = customProviderModelEntry({ id: "deepseek-chat", toolCall: true, reasoning: false, contextLimit: 128000 });
    expect(entry).toEqual({
      name: "deepseek-chat",
      capabilities: { tools: true, reasoning: { supported: false } },
      limit: { context: 128000 },
    });
  });

  test("an output limit the user typed is written as given", () => {
    const entry = customProviderModelEntry({ id: "m", contextLimit: 200_000, outputLimit: 64_000 });
    expect(entry.limit).toEqual({ context: 200_000, output: 64_000 });
  });

  test("an edited model keeps the output limit it was stored with", () => {
    const entry = customProviderModelEntry({
      id: "m",
      toolCall: false,
      reasoning: true,
      contextLimit: 32000,
      outputLimit: 8000,
    });
    expect(entry).toEqual({ name: "m", capabilities: { tools: false, reasoning: { supported: true } }, limit: { context: 32000, output: 8000 } });
  });

  test("no context limit means no limit block at all", () => {
    expect(customProviderModelEntry({ id: "m", name: " Pretty ", contextLimit: null })).toEqual({ name: "Pretty" });
  });

  test("reading a stored entry back preserves both limits through a save round trip", () => {
    const stored = { name: "m", capabilities: { tools: true, reasoning: { supported: false } }, limit: { context: 200000, output: 16384 } };
    const row = customProviderModelFromEntry("m", stored);
    expect(row).toEqual({ id: "m", toolCall: true, reasoning: false, contextLimit: 200000, outputLimit: 16384 });
    expect(customProviderModelEntry(row)).toEqual(stored);
  });

  test("a context-only native limit is retained without introducing an output ceiling", () => {
    const row = customProviderModelFromEntry("m", { limit: { context: 4096 } });
    expect(row.outputLimit).toBeNull();
    expect(customProviderModelEntry(row).limit).toEqual({ context: 4096 });
  });

  test("editing a model preserves its display name and exact API ID", () => {
    const id = "accounts/fireworks/models/deepseek-v4-pro";
    const stored = { name: "DeepSeek V4 Pro", capabilities: { tools: false, reasoning: { supported: true } } };
    const row = customProviderModelFromEntry(id, stored);
    expect(row.id).toBe(id);
    expect(row.name).toBe("DeepSeek V4 Pro");
    expect(customProviderModelEntry(row)).toEqual(stored);
  });
});

describe("findCustomModelLimitProblem", () => {
  test("accepts blank limits, a context alone, and an output below the context", () => {
    expect(
      findCustomModelLimitProblem([
        { id: "a", contextLimit: null, outputLimit: null },
        { id: "b", contextLimit: 128_000, outputLimit: null },
        { id: "c", contextLimit: 128_000, outputLimit: 16_000 },
      ]),
    ).toBeNull();
  });

  test("an explicit output override may inherit the native context size", () => {
    expect(findCustomModelLimitProblem([{ id: "m", contextLimit: null, outputLimit: 8_000 }])).toBeNull();
    expect(customProviderModelEntry({ id: "m", outputLimit: 8_000 }).limit).toEqual({ output: 8_000 });
  });

  test("an output limit at least as large as the context is refused, not quietly replaced", () => {
    expect(findCustomModelLimitProblem([{ id: "m", contextLimit: 8_000, outputLimit: 8_000 }])).toEqual({
      modelId: "m",
      reason: "output-not-below-context",
    });
  });
});

describe("discovered model refresh", () => {
  test("removes retired IDs, adds actual new IDs, and preserves capability edits", () => {
    const kept = { id: "local/qwen", contextLimit: 64000, toolCall: false };
    const current = [kept, { id: "catalog/stale", contextLimit: 32000, toolCall: true }];
    const create = (id: string) => ({ id, contextLimit: 0, toolCall: true });
    expect(replaceDiscoveredModels(current, ["local/new", "local/qwen"], create)).toEqual([
      { id: "local/new", contextLimit: 0, toolCall: true }, kept,
    ]);
    expect(replaceDiscoveredModels(current, [], create)).toEqual([]);
    expect(current).toHaveLength(2);
  });
});
