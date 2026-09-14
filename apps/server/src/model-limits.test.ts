import { describe, expect, test } from "bun:test";

import { buildEigenweltModelsMap } from "./eigenwelt-auth.js";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_LIMIT,
  ENGINE_OUTPUT_CEILING,
  defaultOutputLimit,
  enforcedOutputLimit,
  resolveModelLimit,
} from "./model-limits.js";

describe("resolveModelLimit", () => {
  test("uses the limits the source reports", () => {
    expect(resolveModelLimit({ context: 1_048_576, output: 65_536 })).toEqual({
      limit: { context: 1_048_576, output: 65_536 },
      outputIsDefault: false,
    });
  });

  test("falls back to 32k when the source reports no output limit", () => {
    expect(DEFAULT_OUTPUT_LIMIT).toBe(32_000);
    expect(resolveModelLimit({ context: 1_048_576 })).toEqual({
      limit: { context: 1_048_576, output: 32_000 },
      outputIsDefault: true,
    });
  });

  test("treats 0, negatives and non-numbers as unknown (LiteLLM reports 0 for unknown models)", () => {
    for (const output of [0, -5, Number.NaN, "65536", null]) {
      expect(resolveModelLimit({ context: 200_000, output }).limit.output).toBe(32_000);
    }
    expect(resolveModelLimit({ context: 0 }).limit.context).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test("always returns both keys — the engine rejects a limit block missing either", () => {
    const { limit } = resolveModelLimit({});
    expect(Object.keys(limit).sort()).toEqual(["context", "output"]);
    expect(limit).toEqual({ context: DEFAULT_CONTEXT_LIMIT, output: 32_000 });
  });

  test("never lets the default eat more than half a small context window", () => {
    // The engine reserves the output limit out of the context; a 32k default on
    // an 8k model would leave no room for the conversation at all.
    expect(resolveModelLimit({ context: 8_192 }).limit).toEqual({ context: 8_192, output: 4_096 });
    expect(defaultOutputLimit(1)).toBe(1);
  });

  test("rejects a reported output limit that leaves no room for input", () => {
    expect(resolveModelLimit({ context: 8_000, output: 8_000 })).toEqual({
      limit: { context: 8_000, output: 4_000 },
      outputIsDefault: true,
    });
  });

  test("rounds fractional counts down to whole tokens", () => {
    expect(resolveModelLimit({ context: 100_000.9, output: 4_096.7 }).limit).toEqual({ context: 100_000, output: 4_096 });
  });
});

describe("enforcedOutputLimit", () => {
  test("mirrors the engine: the configured value, never above its ceiling", () => {
    expect(enforcedOutputLimit(16_384)).toBe(16_384);
    expect(enforcedOutputLimit(65_536)).toBe(ENGINE_OUTPUT_CEILING);
    expect(enforcedOutputLimit(undefined)).toBe(ENGINE_OUTPUT_CEILING);
  });
});

describe("buildEigenweltModelsMap", () => {
  test("takes the output limit from the manifest, and the default only where it is missing", () => {
    expect(
      buildEigenweltModelsMap([
        { id: "Eigenwelt Europe Gemini", contextLength: 1_048_576, maxOutputTokens: 65_536 },
        { id: "Eigenwelt Europe GLM", contextLength: 1_048_576 },
        { id: "Bare" },
      ]),
    ).toEqual({
      "Eigenwelt Europe Gemini": {
        name: "Eigenwelt Europe Gemini",
        tool_call: true,
        reasoning: false,
        limit: { context: 1_048_576, output: 65_536 },
      },
      "Eigenwelt Europe GLM": {
        name: "Eigenwelt Europe GLM",
        tool_call: true,
        reasoning: false,
        limit: { context: 1_048_576, output: 32_000 },
      },
      Bare: { name: "Bare", tool_call: true, reasoning: false, limit: { context: 128_000, output: 32_000 } },
    });
  });

  test("no model is left on the old hardcoded 16,384", () => {
    const built = buildEigenweltModelsMap([{ id: "a", contextLength: 1_048_576 }]) as Record<
      string,
      { limit: { output: number } }
    >;
    expect(built.a!.limit.output).not.toBe(16_384);
  });
});
