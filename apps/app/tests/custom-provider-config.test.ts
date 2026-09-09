import { describe, expect, test } from "bun:test";

import {
  customProviderModelEntry,
  customProviderModelFromEntry,
  DEFAULT_MODEL_OUTPUT_LIMIT,
} from "../src/react-app/domains/connections/provider-auth/custom-provider-config";

describe("custom provider model config", () => {
  test("a context limit always produces a limit block with BOTH keys", () => {
    const entry = customProviderModelEntry({ id: "deepseek-chat", toolCall: true, reasoning: false, contextLimit: 128000 });
    expect(entry).toEqual({
      name: "deepseek-chat",
      tool_call: true,
      limit: { context: 128000, output: DEFAULT_MODEL_OUTPUT_LIMIT },
    });
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
    expect(customProviderModelEntry(row).limit).toEqual({ context: 4096, output: DEFAULT_MODEL_OUTPUT_LIMIT });
  });
});
