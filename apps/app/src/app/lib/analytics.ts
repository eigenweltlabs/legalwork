/**
 * Product analytics for the LegalWork desktop app (PostHog, zero-dependency).
 *
 * Principles:
 * - Never send message content, file paths, code, or prompts. Only event
 *   names, counts, lengths, durations, and coarse context (workspace type,
 *   provider/model id). Sole exception: answers the user types directly
 *   into an explicit survey field (e.g. the onboarding attribution survey).
 * - Fire-and-forget: analytics must never break or slow the app.
 * - Respect the user: analytics are opt-in via a single `analyticsEnabled`
 *   preference (onboarding or Settings -> Privacy) — off until explicitly on.
 * - Every capture is mirrored into the local app inspector
 *   (`window.__legalwork.record("analytics.<event>")`) so coded evals can
 *   assert instrumentation without any analytics backend.
 */
import { recordInspectorEvent } from "./app-inspector";
import { isOfficeAddinRuntime } from "./runtime-env";
import { officeHostName } from "@/word-addin/office";

const ENV_POSTHOG_KEY = String(import.meta.env.VITE_LEGALWORK_POSTHOG_KEY ?? "").trim();
const ENV_POSTHOG_HOST = String(import.meta.env.VITE_LEGALWORK_POSTHOG_HOST ?? "").trim();
const ENV_APP_VERSION = String(import.meta.env.VITE_LEGALWORK_APP_VERSION ?? "").trim();

// LegalWork's PostHog project (EU region). PostHog client keys are publishable
// by design. Override or blank via VITE_LEGALWORK_POSTHOG_KEY / _HOST.
const DEFAULT_POSTHOG_KEY = "phc_mvBQ5pbmKNZPmLn6c6bMZb9yXqEtf6bvSPZBa5vwRJfw";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

// Production builds send usage analytics to LegalWork's PostHog (the default key
// above, or VITE_LEGALWORK_POSTHOG_KEY). Dev builds send nothing so local work
// never pollutes analytics; the inspector mirror still records events locally
// either way, and the user's analyticsEnabled preference still turns it all off.
const POSTHOG_KEY = ENV_POSTHOG_KEY || (import.meta.env.DEV ? "" : DEFAULT_POSTHOG_KEY);
const POSTHOG_HOST = (ENV_POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");

const PREFS_STORAGE_KEY = "legalwork.preferences";
const DISTINCT_ID_STORAGE_KEY = "legalwork.analytics.distinctId";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH = 50;

export type AnalyticsProperties = Record<string, string | number | boolean | null | readonly string[]>;

type QueuedEvent = {
  event: string;
  properties: AnalyticsProperties;
  timestamp: string;
};

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "analyticsEnabled" in parsed) {
      // Opt-in: only send when the user explicitly turned it on.
      return (parsed as { analyticsEnabled?: unknown }).analyticsEnabled === true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getAnalyticsDistinctId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(DISTINCT_ID_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(DISTINCT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "unknown";
  }
}

function baseProperties(): AnalyticsProperties {
  return {
    app_version: ENV_APP_VERSION || null,
    platform: typeof navigator === "undefined" ? null : navigator.platform || null,
  };
}

/**
 * Where an event was triggered: the desktop app, or a specific Office add-in
 * pane. NOT a base property — attached explicitly to the events that can fire
 * inside the pane.
 */
export type AnalyticsSurface = "desktop" | "word" | "excel" | "powerpoint" | "office";
export function analyticsSurface(): AnalyticsSurface {
  if (!isOfficeAddinRuntime()) return "desktop";
  const host = officeHostName();
  return host === "word" || host === "excel" || host === "powerpoint" ? host : "office";
}

/**
 * Queue an analytics event. Always mirrored to the local inspector;
 * only sent over the network when enabled and a key is configured.
 */
export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}) {
  try {
    recordInspectorEvent(`analytics.${event}`, properties);
  } catch {
    // Inspector unavailable (non-browser context).
  }

  if (!POSTHOG_KEY || !isAnalyticsEnabled()) return;

  queue.push({
    event,
    properties: { ...baseProperties(), ...properties },
    timestamp: new Date().toISOString(),
  });
  if (queue.length >= MAX_BATCH) {
    void flushAnalytics();
  }
}

export async function flushAnalytics(): Promise<void> {
  if (queue.length === 0 || !POSTHOG_KEY) return;
  const batch = queue.splice(0, MAX_BATCH);
  const distinctId = getAnalyticsDistinctId();

  try {
    await fetch(`${POSTHOG_HOST}/batch/`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        batch: batch.map((entry) => ({
          event: entry.event,
          distinct_id:
            typeof entry.properties.distinct_id === "string"
              ? entry.properties.distinct_id
              : distinctId,
          timestamp: entry.timestamp,
          properties: entry.properties,
        })),
      }),
    });
  } catch {
    // Network failure — drop silently. Analytics must never surface errors.
  }
}

// Task run duration tracking: sendDraft marks the start, the session.idle
// sync event takes it. Also acts as a dedupe guard so idle events that do
// not correspond to an instrumented run (or arrive from a second workspace
// sync) emit nothing.
const taskRunStarts = new Map<string, number>();

export function markTaskRunStart(sessionId: string) {
  if (sessionId.trim()) taskRunStarts.set(sessionId, Date.now());
}

export function takeTaskRunStart(sessionId: string): number | null {
  const startedAt = taskRunStarts.get(sessionId);
  if (startedAt === undefined) return null;
  taskRunStarts.delete(sessionId);
  return startedAt;
}

/**
 * One-time setup: flush loop and unload flush. Mounted from AppRoot.
 */
export function initAnalytics() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  flushTimer = setInterval(() => void flushAnalytics(), FLUSH_INTERVAL_MS);

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAnalytics();
  });
}

export function disposeAnalytics() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  initialized = false;
  queue = [];
}
