/**
 * Consent gating for the analytics send queue — opt-OUT model:
 * - pending choice (null, the welcome screen with the toggle showing on):
 *   events queue but are held — nothing is sent until the choice commits on;
 * - explicit opt-out: later captures are discarded and the queue is purged;
 * - toggle left on: queued events are sent once the choice is saved.
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

describe("analytics consent gating", () => {
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

  test("pending choice holds the queue until the choice commits on", async () => {
    setConsent(null);
    captureAnalyticsEvent("welcome_window_event");
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);

    setConsent(true);
    await flushAnalytics();
    expect(sentEvents()).toEqual(["welcome_window_event"]);
  });

  test("pending choice holds at most one batch, keeping the earliest events", async () => {
    setConsent(null);
    for (let index = 0; index < 60; index += 1) captureAnalyticsEvent(`held_${index}`);
    expect(sentEvents()).toEqual([]);

    setConsent(true);
    await flushAnalytics();
    await flushAnalytics();
    expect(sentEvents()).toHaveLength(50);
    expect(sentEvents()[0]).toBe("held_0");
  });

  test("opt-out purges the queue and silences later captures", async () => {
    setConsent(null);
    captureAnalyticsEvent("still_queued");

    setConsent(false);
    await flushAnalytics(); // purges the queue
    captureAnalyticsEvent("after_optout");
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);

    // Turning analytics back on must not resurrect events purged under refusal.
    setConsent(true);
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);
  });

  test("committing opt-out discards pending events without sending anything", async () => {
    setConsent(null);
    captureAnalyticsEvent("captured_but_unsent");

    discardPendingAnalytics();
    setConsent(false);
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);

    // Turning analytics back on must not resurrect events from before the opt-out.
    setConsent(true);
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);
  });

  test("enabled analytics sends captures on flush", async () => {
    setConsent(true);
    captureAnalyticsEvent("normal_event");
    await flushAnalytics();
    expect(sentEvents()).toContain("normal_event");
  });
});
