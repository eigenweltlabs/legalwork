import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getStoredAnalyticsConsent, isAnalyticsEnabled } from "../src/app/lib/analytics";

// Regression test for the onboarding welcome toggle defaulting off on fresh
// installs. The toggle is seeded with `getStoredAnalyticsConsent() ?? true`,
// so it only defaults on when the stored preference reads as "unset" (null).
// The bug: LocalProvider persisted a concrete default for the preference at
// startup, so getStoredAnalyticsConsent() returned a real boolean instead of
// null and the `?? true` fallback never fired.

const PREFS_STORAGE_KEY = "legalwork.preferences";
const originalWindow = globalThis.window;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

/** What the welcome screen actually seeds the toggle with. */
function welcomeToggleDefault() {
  return getStoredAnalyticsConsent() ?? true;
}

/** Persist a prefs object the way LocalProvider does (JSON.stringify of prefs). */
function persistPrefs(prefs: Record<string, unknown>) {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
}

describe("onboarding consent default", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: memoryStorage() },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("fresh install (no stored prefs): toggle defaults on, nothing sends", () => {
    expect(getStoredAnalyticsConsent()).toBeNull();
    expect(welcomeToggleDefault()).toBe(true);
    expect(isAnalyticsEnabled()).toBe(false);
  });

  test("after LocalProvider persists the null default: still counts as unset", () => {
    // This is the exact failure mode: LocalProvider writes INITIAL_PREFS to
    // storage at startup, before the welcome screen is routed to. With the
    // fix, analyticsEnabled is null, so the toggle still defaults on.
    persistPrefs({ hasCompletedOnboarding: false, analyticsEnabled: null, showThinking: true });
    expect(getStoredAnalyticsConsent()).toBeNull();
    expect(welcomeToggleDefault()).toBe(true);
    expect(isAnalyticsEnabled()).toBe(false);
  });

  test("regression: a persisted concrete false would defeat the default (old bug)", () => {
    // Pins the old behaviour: had INITIAL_PREFS kept a concrete `false`, the
    // toggle would read false and render off even for a user who never chose.
    persistPrefs({ hasCompletedOnboarding: false, analyticsEnabled: false, showThinking: true });
    expect(getStoredAnalyticsConsent()).toBe(false);
    expect(welcomeToggleDefault()).toBe(false);
  });

  test("explicit opt-out is preserved on re-entry", () => {
    persistPrefs({ hasCompletedOnboarding: true, analyticsEnabled: false });
    expect(getStoredAnalyticsConsent()).toBe(false);
    expect(welcomeToggleDefault()).toBe(false);
    expect(isAnalyticsEnabled()).toBe(false);
  });

  test("explicit opt-in is honoured", () => {
    persistPrefs({ hasCompletedOnboarding: true, analyticsEnabled: true });
    expect(getStoredAnalyticsConsent()).toBe(true);
    expect(welcomeToggleDefault()).toBe(true);
    expect(isAnalyticsEnabled()).toBe(true);
  });
});
