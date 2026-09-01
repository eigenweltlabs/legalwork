/**
 * Consent gating for the analytics send queue. The contract:
 * - pending choice (null, the welcome screen): events queue in memory,
 *   nothing is sent;
 * - explicit opt-in: the pending queue and later captures are sent;
 * - explicit opt-out: later captures are discarded and the pending queue is
 *   dropped — nothing ever leaves the device without a stored "yes".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// The module gates every capture on a configured key — inject one before import.
process.env.VITE_LEGALWORK_POSTHOG_KEY = "phc_test_dummy_key";

const { captureAnalyticsEvent, flushAnalytics } = await import("../src/app/lib/analytics");

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

  test("pending choice queues without sending; opt-in releases the queue", async () => {
    setConsent(null);
    captureAnalyticsEvent("pending_event");
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);

    setConsent(true);
    await flushAnalytics();
    expect(sentEvents()).toContain("pending_event");
  });

  test("opt-out drops the pending queue and silences later captures", async () => {
    setConsent(null);
    captureAnalyticsEvent("doomed_event");

    setConsent(false);
    await flushAnalytics(); // purges the queue
    captureAnalyticsEvent("after_optout");
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);

    // A later opt-in must not resurrect what was captured before/under refusal.
    setConsent(true);
    await flushAnalytics();
    expect(sentEvents()).toEqual([]);
  });

  test("opt-in sends captures on flush", async () => {
    setConsent(true);
    captureAnalyticsEvent("normal_event");
    await flushAnalytics();
    expect(sentEvents()).toContain("normal_event");
  });
});
