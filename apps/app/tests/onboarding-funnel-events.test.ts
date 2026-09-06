/**
 * Onboarding funnel events on the welcome screen.
 *
 * `onboarding_started` marks INTENT (the user committed to creating a
 * workspace), not success — success is `workspace_created`. Intent is flushed
 * eagerly, like `onboarding_welcome_viewed`, because the consent choice
 * commits at the end of workspace creation and an opt-out there purges
 * whatever is still queued. Without the eager flush an opted-out user reports
 * as a welcome view with no start, which reads as a drop-off that never
 * happened.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// The module gates every capture on a configured key — inject one before import.
process.env.VITE_LEGALWORK_POSTHOG_KEY = "phc_test_dummy_key";

const { captureAnalyticsEvent, captureAnalyticsOptOut, flushAnalytics } = await import(
  "../src/app/lib/analytics"
);

const PREFS_STORAGE_KEY = "legalwork.preferences";
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

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

function setConsent(value: boolean | null) {
  if (value === null) window.localStorage.removeItem(PREFS_STORAGE_KEY);
  else window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ analyticsEnabled: value }));
}

const sentBatches: Array<{ event: string }[]> = [];
function sentEvents(): string[] {
  return sentBatches.flat().map((entry) => entry.event);
}

/** The welcome screen up to the moment the consent choice commits. */
async function runWelcomeUpToConsentCommit() {
  captureAnalyticsEvent("onboarding_welcome_viewed", { surface: "desktop" });
  await flushAnalytics();
  captureAnalyticsEvent("onboarding_started", { surface: "desktop" });
  await flushAnalytics();
  // ...workspace creation happens here...
  captureAnalyticsEvent("workspace_created", { source: "onboarding", surface: "desktop" });
}

describe("onboarding funnel events", () => {
  beforeEach(() => {
    sentBatches.length = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: memoryStorage() },
    });
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body
        ? (JSON.parse(init.body) as { batch: { event: string }[] })
        : { batch: [] };
      sentBatches.push(body.batch);
      return { ok: true } as Response;
    }) as typeof fetch;
  });

  afterEach(async () => {
    // Drain any queued events so state never leaks into the next test.
    setConsent(false);
    await flushAnalytics();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    globalThis.fetch = originalFetch;
  });

  test("opting out at the end still reports the start, so the funnel is measurable", async () => {
    setConsent(null);
    await runWelcomeUpToConsentCommit();
    setConsent(false);
    captureAnalyticsOptOut("onboarding");

    expect(sentEvents()).toContain("onboarding_welcome_viewed");
    // The regression this pins: queued-only, `onboarding_started` was purged
    // by the opt-out and the user looked like a welcome-screen drop-off.
    expect(sentEvents()).toContain("onboarding_started");
    expect(sentEvents()).toContain("analytics_opted_out");
  });

  test("the opt-out still purges anything not yet flushed", async () => {
    setConsent(null);
    await runWelcomeUpToConsentCommit();
    setConsent(false);
    captureAnalyticsOptOut("onboarding");

    expect(sentEvents()).not.toContain("workspace_created");
  });

  test("staying opted in reports intent and success separately", async () => {
    setConsent(null);
    await runWelcomeUpToConsentCommit();
    setConsent(true);
    await flushAnalytics();

    expect(sentEvents()).toContain("onboarding_started");
    expect(sentEvents()).toContain("workspace_created");
    expect(sentEvents()).not.toContain("analytics_opted_out");
  });
});
