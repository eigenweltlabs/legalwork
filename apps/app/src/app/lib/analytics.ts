/**
 * Product analytics for the LegalWork desktop app (PostHog, zero-dependency).
 *
 * Principles:
 * - Never send message content, file paths, code, or prompts. Only event
 *   names, counts, durations, and coarse context (provider/model id, app
 *   version, platform).
 * - The distinct id lives in memory and rotates per app start — never
 *   persisted to localStorage or disk. The local server mints it per launch;
 *   desktop and Office pane adopt it via setAnalyticsDistinctId, with a
 *   local mint as boot-time fallback.
 * - Location is capped at city level server-side (the "GeoIP city cap"
 *   transformation in the PostHog project — keep it enabled after GeoIP);
 *   events are anonymous ($process_person_profile: false).
 * - Fire-and-forget: analytics must never break or slow the app.
 * - Opt-OUT model: analytics is on by default (the welcome toggle shows the
 *   default), but nothing is sent until the welcome screen has committed the
 *   choice: events captured while it is pending are held in memory and only
 *   flushed if the user left the toggle on. Opting out (welcome toggle or
 *   Settings -> Privacy) takes effect immediately: captures stop and the send
 *   queue is purged. Only an explicit Share error click can send one selected
 *   technical error after opt-out; it never enables general analytics.
 * - Every capture is mirrored into the local app inspector
 *   (`window.__legalwork.record("analytics.<event>")`) so coded evals can
 *   assert instrumentation without any analytics backend.
 */
import { recordInspectorEvent } from "./app-inspector";
import { isOfficeAddinRuntime } from "./runtime-env";
import { officeHostName } from "@/word-addin/office";
import { ErrorDiagnosticSchema, errorExceptionProperties, type ErrorDiagnostic } from "@legalwork/types/error-report";
import { FullErrorDetailsSchema, fullExceptionList, type FullErrorDetails } from "@legalwork/types/error-details";

const ENV_POSTHOG_KEY = String(import.meta.env.VITE_LEGALWORK_POSTHOG_KEY ?? "").trim();
const ENV_POSTHOG_HOST = String(import.meta.env.VITE_LEGALWORK_POSTHOG_HOST ?? "").trim();
const ENV_APP_VERSION = String(import.meta.env.VITE_LEGALWORK_APP_VERSION ?? "").trim();

// LegalWork's PostHog projects (EU region). PostHog client keys are publishable
// by design. Alpha builds (stamped version `x.y.z-alpha.<run>.<sha>`) report to
// the "LegalWork Dev & Alpha" project so they never mix with stable data.
// Override or blank via VITE_LEGALWORK_POSTHOG_KEY / _HOST.
const STABLE_POSTHOG_KEY = "phc_mvBQ5pbmKNZPmLn6c6bMZb9yXqEtf6bvSPZBa5vwRJfw";
const ALPHA_POSTHOG_KEY = "phc_Bfnpz8tU5KkWcQ3uzqe99RPL74RuQXLJvHs9zPWZqRqJ";
const DEFAULT_POSTHOG_KEY = ENV_APP_VERSION.includes("-alpha")
  ? ALPHA_POSTHOG_KEY
  : STABLE_POSTHOG_KEY;
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

// Production builds send usage analytics to LegalWork's PostHog (the default key
// above, or VITE_LEGALWORK_POSTHOG_KEY). Dev builds send nothing so local work
// never pollutes analytics; the inspector mirror still records events locally
// either way, and the user's analyticsEnabled preference still turns it all off.
const POSTHOG_KEY = ENV_POSTHOG_KEY || (import.meta.env.DEV ? "" : DEFAULT_POSTHOG_KEY);
const POSTHOG_HOST = (ENV_POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");

const PREFS_STORAGE_KEY = "legalwork.preferences";
// Earlier builds persisted the distinct id here; initAnalytics cleans it up.
const LEGACY_DISTINCT_ID_STORAGE_KEY = "legalwork.analytics.distinctId";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH = 50;

export type AnalyticsProperties = Record<string, string | number | boolean | null | readonly string[]>;

type QueuedEvent = {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  uuid: string;
  attempts: number;
};
type PostHogEvent = Omit<QueuedEvent, "attempts"> & { distinct_id: string };

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let flushing = false;
let consentEpoch = 0;

/** The stored consent choice, or null when the user never made one. */
export function getStoredAnalyticsConsent(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "analyticsEnabled" in parsed) {
      const value = (parsed as { analyticsEnabled?: unknown }).analyticsEnabled;
      return typeof value === "boolean" ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

// The Office pane mirrors the desktop's consent (adopted from the server
// bootstrap, refreshed by polling — see word-addin/index.tsx). Memory only.
let consentOverride: boolean | null = null;
export function setAnalyticsConsentOverride(enabled: boolean): void {
  consentOverride = enabled;
  if (!enabled) discardPendingAnalytics();
}

export function isAnalyticsEnabled(): boolean {
  if (consentOverride !== null) return consentOverride;
  return getStoredAnalyticsConsent() === true;
}

/**
 * Explicit opt-out. Distinct from "not enabled": a pending choice (null —
 * the welcome screen, where the toggle shows on) still queues, but the queue
 * is held until the choice commits (see flushAnalytics). Only a stored "no"
 * silences — from that moment captures are discarded and the queue is purged.
 */
function isAnalyticsRefused(): boolean {
  if (consentOverride !== null) return !consentOverride;
  return getStoredAnalyticsConsent() === false;
}

/** True when a capture would actually be sent — lets callers skip enrichment work. */
export function isAnalyticsSending(): boolean {
  return Boolean(POSTHOG_KEY) && isAnalyticsEnabled();
}

// Per-launch analytics id: minted in memory on first use, never persisted.
// Normally replaced by the server's launch id via setAnalyticsDistinctId.
let runtimeDistinctId = "";

export function getAnalyticsDistinctId(): string {
  if (runtimeDistinctId) return runtimeDistinctId;
  try {
    runtimeDistinctId = crypto.randomUUID();
  } catch {
    runtimeDistinctId = `lw.${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }
  return runtimeDistinctId;
}

/** Adopt the server's per-launch id so desktop + pane count as one user. */
export function setAnalyticsDistinctId(id: string): void {
  const trimmed = id.trim();
  if (trimmed) runtimeDistinctId = trimmed;
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
  enqueueAnalyticsEvent(event, properties);
}

const recentExceptions = new Map<string, number>();
export function captureErrorAnalytics(diagnostic: ErrorDiagnostic): void {
  if (diagnostic.code === "cancelled" || !POSTHOG_KEY || isAnalyticsRefused()) return;
  const now = Date.now();
  if (now - (recentExceptions.get(diagnostic.fingerprint) ?? 0) < 5000) return;
  for (const [key, at] of recentExceptions) if (now - at >= 60_000) recentExceptions.delete(key);
  if (recentExceptions.size >= 20) return;
  recentExceptions.set(diagnostic.fingerprint, now);
  enqueueAnalyticsEvent("$exception", { ...errorExceptionProperties(diagnostic), error_origin: "automatic" });
}

/** The exact event previewed by Share error, with an anonymous, per-event identity. */
export function makeManualErrorEvent(diagnostic: ErrorDiagnostic, eventId: string, fullDetails?: FullErrorDetails) {
  const error = ErrorDiagnosticSchema.parse(diagnostic);
  const id = ErrorDiagnosticSchema.shape.incident_id.parse(eventId);
  const details = fullDetails ? FullErrorDetailsSchema.parse(fullDetails) : null;
  return {
    uuid: id, event: "$exception", distinct_id: `manual-error:${id}`,
    timestamp: error.occurred_at,
    properties: {
      ...errorExceptionProperties(error), error_origin: "manual",
      ...(details ? { $exception_list: fullExceptionList(details), error_details: details } : {}),
    },
  };
}

/** Call only after an explicit Share click. Does not read or change analytics consent. */
export async function sendManualErrorEvent(diagnostic: ErrorDiagnostic, eventId: string, fetchImpl: typeof fetch = globalThis.fetch, fullDetails?: FullErrorDetails): Promise<string> {
  if (!POSTHOG_KEY) throw new Error("error_sharing_unavailable");
  const event = makeManualErrorEvent(diagnostic, eventId, fullDetails);
  // Full diagnostics exceed browsers' 64 KiB keepalive quota. Keep the dialog open
  // until delivery finishes, with a longer timeout than automatic batches.
  const response = await postHogBatch([event], fetchImpl, true);
  if (!response.ok) throw new Error("error_event_not_sent");
  return event.uuid;
}

function postHogBatch(events: readonly PostHogEvent[], fetchImpl: typeof fetch = globalThis.fetch, manual = false): Promise<Response> {
  return fetchImpl(`${POSTHOG_HOST}/batch/`, {
    method: "POST", keepalive: !manual, credentials: "omit", cache: "no-store",
    signal: AbortSignal.timeout(manual ? 30_000 : 5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: POSTHOG_KEY, batch: events }),
  });
}

function enqueueAnalyticsEvent(event: string, properties: Record<string, unknown>) {
  try {
    recordInspectorEvent(`analytics.${event}`, properties);
  } catch {
    // Inspector unavailable (non-browser context).
  }

  // Refused = silence. A pending choice (welcome screen) queues, so the
  // onboarding events fired before the choice persists are not lost, but
  // flushAnalytics holds them until it does. Held events are capped at one
  // batch: the choice may never come (no welcome screen shown this launch).
  if (!POSTHOG_KEY || isAnalyticsRefused()) return;
  if (queue.length >= MAX_BATCH * (isAnalyticsEnabled() ? 2 : 1)) return;

  queue.push({
    event,
    properties: { ...baseProperties(), ...properties },
    timestamp: new Date().toISOString(),
    uuid: crypto.randomUUID(), attempts: 0,
  });
  if (queue.length >= MAX_BATCH) {
    void flushAnalytics();
  }
}

/** Drop events captured before a newly committed opt-out. */
export function discardPendingAnalytics(): void {
  queue = [];
  consentEpoch++;
}

export async function flushAnalytics(): Promise<void> {
  if (!POSTHOG_KEY || flushing) return;
  if (isAnalyticsRefused()) {
    // Consent withdrawn — drop anything still queued.
    discardPendingAnalytics();
    return;
  }
  // Choice still pending: hold the queue. Nothing leaves the machine before
  // the user could turn analytics off on the welcome screen.
  if (!isAnalyticsEnabled() || queue.length === 0) return;
  flushing = true;
  const epoch = consentEpoch;
  const batch = queue.splice(0, MAX_BATCH);
  for (const entry of batch) entry.attempts++;
  const retry = () => {
    if (epoch !== consentEpoch || isAnalyticsRefused()) return;
    queue = [...batch.filter(entry => entry.attempts < 3), ...queue].slice(0, MAX_BATCH * 2);
  };
  const distinctId = getAnalyticsDistinctId();

  try {
    const response = await postHogBatch(batch.map((entry) => ({
      uuid: entry.uuid,
      event: entry.event,
      distinct_id: distinctId,
      timestamp: entry.timestamp,
      // Anonymous events — no person profiles.
      properties: { ...entry.properties, $process_person_profile: false },
    })));
    if (!response.ok && (response.status === 429 || response.status >= 500)) retry();
  } catch {
    // Bounded, in-memory retry; no content-bearing disk queue or user-facing error.
    retry();
  } finally { flushing = false; }
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

  // Remove the distinct id persisted by earlier builds.
  try {
    window.localStorage.removeItem(LEGACY_DISTINCT_ID_STORAGE_KEY);
  } catch {
    // Storage unavailable.
  }

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
  consentOverride = null;
  recentExceptions.clear();
  discardPendingAnalytics();
}
