import { describe, expect, test } from "bun:test";

import { DEFAULT_OUTPUT_LIMIT } from "@legalwork/types/model-limits";
import {
  customProviderModelEntry,
  customProviderModelFromEntry,
  findCustomModelLimitProblem,
  replaceDiscoveredModels,
} from "../src/react-app/domains/connections/provider-auth/custom-provider-config";

describe("custom provider model config", () => {
  test("a context limit always produces a limit block with BOTH keys", () => {
    const entry = customProviderModelEntry({ id: "deepseek-chat", toolCall: true, reasoning: false, contextLimit: 128000 });
    expect(entry).toEqual({
      name: "deepseek-chat",
      tool_call: true,
      limit: { context: 128000, output: DEFAULT_OUTPUT_LIMIT },
    });
    expect(DEFAULT_OUTPUT_LIMIT).toBe(32_000);
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
    expect(entry).toEqual({ name: "m", tool_call: false, reasoning: true, limit: { context: 32000, output: 8000 } });
  });

  test("no context limit means no limit block at all", () => {
    expect(customProviderModelEntry({ id: "m", name: " Pretty ", contextLimit: null })).toEqual({ name: "Pretty" });
  });

  test("reading a stored entry back preserves both limits through a save round trip", () => {
    const stored = { name: "m", tool_call: true, limit: { context: 200000, output: 16384 } };
    const row = customProviderModelFromEntry("m", stored);
    expect(row).toEqual({ id: "m", toolCall: true, reasoning: false, contextLimit: 200000, outputLimit: 16384 });
    expect(customProviderModelEntry(row)).toEqual(stored);
  });

  test("a stored entry with a broken limit is repaired on the next save", () => {
    const row = customProviderModelFromEntry("m", { limit: { context: 4096 } });
    expect(row.outputLimit).toBeNull();
    // Half the window, not the full default: 32k reserved out of a 4k context
    // would leave the engine no room for input at all.
    expect(customProviderModelEntry(row).limit).toEqual({ context: 4096, output: 2048 });
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

  test("an output limit needs a context limit to travel with", () => {
    expect(findCustomModelLimitProblem([{ id: "m", contextLimit: null, outputLimit: 8_000 }])).toEqual({
      modelId: "m",
      reason: "output-needs-context",
    });
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
