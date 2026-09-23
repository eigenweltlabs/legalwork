/**
 * Onboarding funnel events on the welcome screen.
 *
 * `onboarding_started` marks INTENT (the user committed to creating a
 * workspace), not success — success is `workspace_created`. Nothing from the
 * welcome screen is sent before the consent choice commits at the end of
 * workspace creation: leaving the toggle on then sends the whole funnel, while an
 * opt-out sends nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// The module gates every capture on a configured key — inject one before import.
process.env.VITE_LEGALWORK_POSTHOG_KEY = "phc_test_dummy_key";

const { captureAnalyticsEvent, discardPendingAnalytics, disposeAnalytics, flushAnalytics } = await import(
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

/**
 * The welcome screen up to the moment the consent choice commits. The flush
 * timer (or the window hiding) may fire at any point in between.
 */
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
    // Test files share this module: drop whatever earlier files left queued.
    disposeAnalytics();
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

  test("opting out on the welcome screen sends nothing", async () => {
    setConsent(null);
    await runWelcomeUpToConsentCommit();
    discardPendingAnalytics();
    setConsent(false);
    await flushAnalytics();

    expect(sentEvents()).toEqual([]);
  });

  test("leaving the toggle on sends the whole funnel once the choice commits", async () => {
    setConsent(null);
    await runWelcomeUpToConsentCommit();
    expect(sentEvents()).toEqual([]);

    setConsent(true);
    await flushAnalytics();
    expect(sentEvents()).toEqual(["onboarding_welcome_viewed", "onboarding_started", "workspace_created"]);
  });
});
