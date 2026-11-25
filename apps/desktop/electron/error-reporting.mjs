// Error reporting with Sentry, for the main process (which also runs the
// embedded LegalWork server) and every app window.
//
// Nothing is sent unless the user has turned on "share anonymous usage" and
// the firm's policy allows it; the window tells us the current choice and we
// keep it in <userData>/error-reporting.json so the main process knows it at
// the next start. Every event is cleaned by scrubEvent() first (see
// error-reporting-scrub.mjs for exactly what may leave the machine).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as Sentry from "@sentry/electron/main";
import { app } from "electron";

import { createConsentGatedTransport, scrubBreadcrumb, scrubEvent } from "./error-reporting-scrub.mjs";

// Public client key of the self-hosted Sentry project "legalwork-desktop".
// It only allows sending events, like the PostHog key in analytics.ts.
// LEGALWORK_SENTRY_DSN overrides it; set it to an empty string to disable.
const DEFAULT_DSN = "https://3174a5a4437283b0d92ee6fe0034d536@sentry.eigenweltlabs.com/2";

// Integrations that could carry document content or are not wanted here:
// native crash dumps hold memory (which can include document text), local
// variable values can hold anything the code was working on, screenshots show
// the screen, console breadcrumbs repeat log lines.
const REMOVED_INTEGRATIONS = new Set([
  "SentryMinidump",
  "ElectronMinidump",
  "Screenshots",
  "LocalVariables",
  "LocalVariablesAsync",
  "Console",
]);

const CONSENT_FILE = "error-reporting.json";

let initialized = false;
let consentGranted = false;

function consentPath() {
  return path.join(app.getPath("userData"), CONSENT_FILE);
}

function readStoredConsent() {
  try {
    return JSON.parse(readFileSync(consentPath(), "utf8"))?.enabled === true;
  } catch {
    return false;
  }
}

function resolveDsn() {
  const fromEnv = process.env.LEGALWORK_SENTRY_DSN;
  if (typeof fromEnv === "string") return fromEnv.trim();
  return DEFAULT_DSN;
}

function resolveEnvironment(version) {
  if (!app.isPackaged) return "development";
  return version.includes("-alpha") ? "alpha" : "production";
}

/**
 * Start Sentry in the main process. Call once, after the app's name and
 * userData path are set and before the app is ready, so crashes of windows
 * created later are seen. Without a DSN this does nothing.
 */
export function initErrorReporting() {
  if (initialized) return;
  const dsn = resolveDsn();
  if (!dsn) return;
  consentGranted = readStoredConsent();
  const version = app.getVersion();
  try {
    Sentry.init({
      dsn,
      release: `legalwork-desktop@${version}`,
      environment: resolveEnvironment(version),
      serverName: "legalwork-desktop",
      // No user identity, IP address, headers, bodies or local variables.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
      },
      attachScreenshot: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 30,
      integrations: (defaults) => defaults.filter((integration) => !REMOVED_INTEGRATIONS.has(integration.name)),
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      // The SDK's default transport (queues on disk while offline), wrapped so
      // nothing leaves the machine without consent.
      transport: (options) => createConsentGatedTransport(Sentry.makeElectronOfflineTransport()(options), () => consentGranted),
    });
    initialized = true;
  } catch (error) {
    console.warn("[error-reporting] Sentry did not start:", error);
  }
}

/** Store the user's current choice. Called from the window over IPC. */
export function setErrorReportingConsent(enabled) {
  consentGranted = enabled === true;
  if (!initialized) return;
  try {
    const file = consentPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ enabled: consentGranted, updatedAt: new Date().toISOString() })}\n`, "utf8");
  } catch {
    // The in-memory choice still applies for this run.
  }
}

// A crash loop restarts the runtime again and again; a few reports per exit
// code and run are enough to see it.
const MAX_RUNTIME_EXIT_REPORTS = 3;
const runtimeExitReports = new Map();

/** The agent runtime (orchestrator / OpenCode) exited unexpectedly. */
export function reportAgentRuntimeExit(detail) {
  if (!initialized) return;
  const exitCode = typeof detail?.exitCode === "number" ? String(detail.exitCode) : "unknown";
  const count = runtimeExitReports.get(exitCode) ?? 0;
  if (count >= MAX_RUNTIME_EXIT_REPORTS) return;
  runtimeExitReports.set(exitCode, count + 1);
  Sentry.captureMessage("Agent runtime exited unexpectedly", {
    level: "error",
    tags: { service: "agent-runtime", exit_code: exitCode },
    fingerprint: ["agent-runtime-exit", exitCode],
  });
}

/** An unexpected failure inside the embedded LegalWork server (it answered 500). */
export function reportServerError(error, context) {
  if (!initialized) return;
  Sentry.captureException(error, {
    tags: {
      service: "legalwork-server",
      http_method: typeof context?.method === "string" ? context.method : "unknown",
      route: typeof context?.route === "string" ? context.route : "unknown",
    },
  });
}
