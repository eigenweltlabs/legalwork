import { describe, expect, test } from "bun:test";

import {
  adoptLaunchAnalyticsId,
  isAdoptableLaunchAnalyticsId,
  launchAnalyticsId,
  resolveLaunchAnalyticsId,
} from "./launch-analytics-id.js";

const OFFER = "11111111-2222-4333-8444-555555555555";

// The id is process-global by design and `bun test src` shares one module
// registry, so any other file in the run may already hold it. The precedence
// rules are therefore asserted through the pure resolver; the stateful pair
// only gets invariants that hold whoever claimed the launch first.
describe("resolveLaunchAnalyticsId", () => {
  test("takes a client offer when nothing is in force", () => {
    expect(resolveLaunchAnalyticsId("", OFFER)).toBe(OFFER);
  });

  test("mints instead of taking an unusable offer", () => {
    const minted = resolveLaunchAnalyticsId("", "crlf\r\nX-Injected: 1");
    expect(minted).not.toBe("crlf\r\nX-Injected: 1");
    expect(isAdoptableLaunchAnalyticsId(minted)).toBe(true);
  });

  test("first writer wins: an id in force is never replaced", () => {
    expect(resolveLaunchAnalyticsId("already-in-force-id", OFFER)).toBe("already-in-force-id");
    expect(resolveLaunchAnalyticsId("already-in-force-id", "")).toBe("already-in-force-id");
  });
});

describe("launch analytics id", () => {
  test("adopting is idempotent and never renames the launch", () => {
    const inForce = adoptLaunchAnalyticsId(OFFER);
    expect(inForce.length).toBeGreaterThan(0);
    expect(adoptLaunchAnalyticsId("99999999-8888-4777-8666-555555555555")).toBe(inForce);
    expect(adoptLaunchAnalyticsId("")).toBe(inForce);
    expect(launchAnalyticsId()).toBe(inForce);
  });
});

describe("adoptable launch id shapes", () => {
  test("accepts what clients actually mint", () => {
    // crypto.randomUUID() in the renderer, and its non-crypto fallback.
    expect(isAdoptableLaunchAnalyticsId(OFFER)).toBe(true);
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
