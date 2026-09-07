import { describe, expect, test } from "bun:test";

import {
  adoptLaunchAnalyticsId,
  isAdoptableLaunchAnalyticsId,
  launchAnalyticsId,
} from "./launch-analytics-id.js";

// The id is process-global by design, so adoption is asserted once, against
// that single lifetime. The shape rules are a pure predicate and get the
// exhaustive treatment.
describe("launch analytics id", () => {
  test("adopts the first client-offered id, then never renames the launch", () => {
    const offered = "11111111-2222-4333-8444-555555555555";
    expect(adoptLaunchAnalyticsId(offered)).toBe(offered);
    expect(launchAnalyticsId()).toBe(offered);
    // First writer wins: a later window or reconnect must not rename it.
    expect(adoptLaunchAnalyticsId("99999999-8888-4777-8666-555555555555")).toBe(offered);
    expect(adoptLaunchAnalyticsId("")).toBe(offered);
  });
});

describe("adoptable launch id shapes", () => {
  test("accepts what clients actually mint", () => {
    // crypto.randomUUID() in the renderer, and its non-crypto fallback.
    expect(isAdoptableLaunchAnalyticsId("11111111-2222-4333-8444-555555555555")).toBe(true);
    expect(isAdoptableLaunchAnalyticsId("lw.k3j4h5g6f7d8s9a0q1w2e3")).toBe(true);
  });

  // The value lands in an outbound header, so header-breaking input must not
  // stick. Empty and short offers are refused so a stray "" cannot claim the
  // launch and collide across installs.
  for (const bad of [
    "",
    "short",
    "has space",
    "crlf\r\nX-Injected: 1",
    "newline\nX-Injected: 1",
    "tab\tsep",
    "semi;colon",
    "unicode-é",
    "x".repeat(65),
  ]) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(isAdoptableLaunchAnalyticsId(bad)).toBe(false);
    });
  }
});
