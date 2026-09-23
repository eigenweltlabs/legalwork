import { describe, expect, test } from "bun:test";

import { tokensMatch } from "./utils.js";

describe("tokensMatch", () => {
  test("accepts the exact secret", () => {
    const token = "a".repeat(64);
    expect(tokensMatch(token, token)).toBe(true);
  });

  test("rejects wrong secrets regardless of where they differ", () => {
    const expected = `${"a".repeat(63)}b`;
    expect(tokensMatch(`${"a".repeat(63)}c`, expected)).toBe(false);
    expect(tokensMatch(`b${"a".repeat(63)}`, expected)).toBe(false);
    expect(tokensMatch("a".repeat(64), expected)).toBe(false);
  });

  test("rejects prefixes and longer guesses without throwing", () => {
    const expected = "correct-host-token";
    expect(tokensMatch("correct-host", expected)).toBe(false);
    expect(tokensMatch(`${expected}-extra`, expected)).toBe(false);
  });

  test("never matches when either side is empty", () => {
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("guess", "")).toBe(false);
    expect(tokensMatch("", "expected")).toBe(false);
  });
});
