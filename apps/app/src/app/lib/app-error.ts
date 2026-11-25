/**
 * App errors.
 *
 * Errors go to error reporting (error-reporting.ts → Sentry, sent by the main
 * process only with the user's consent, cleaned of paths and content first).
 * This module keeps two things the run analytics still use: an allowlisted
 * error class name and a content-free fingerprint for engine session errors.
 */
import { reportError } from "./error-reporting";
import { hashString } from "./hash";

export type AppErrorSource =
  // global (logged here; captured by Sentry's own window handlers)
  | "uncaught"
  | "unhandledrejection"
  | "react_render"
  // explicit (fired from subsystem catch blocks)
  | "workspace_create"
  | "integration_connect";

// Run analytics (session-sync.ts) only ever record these class names; anything
// else is bucketed to "other" so an unexpected (possibly content-bearing) name
// never reaches analytics.
const ALLOWED_ERROR_NAMES = new Set([
  // Standard JS / DOM error classes.
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError",
  "URIError", "AggregateError", "DOMException", "AbortError", "NotFoundError",
  "NetworkError", "TimeoutError",
  // App / server error classes.
  "LegalworkServerError", "ApiError",
  // opencode agent / run-failure reasons (the "why a run failed" types).
  // "APIError" is the engine's own spelling of its wire type and is the one
  // that actually arrives over SSE; "ApiError" above only ever matched a
  // thrown client class, so provider failures were all bucketed to "other".
  "APIError", "UnknownError",
  "ProviderAuthError", "ProviderModelNotFoundError", "ContextOverflowError",
  "MessageOutputLengthError", "StructuredOutputError", "MessageAbortedError",
]);

/**
 * Resolve an error's class name, gated to the allowlist above — anything else
 * (including a name derived from runtime/user data) becomes "other" so the
 * field can only ever hold a compile-time constant from our own code.
 */
export function allowlistedErrorName(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.name || error.constructor?.name || "Error")
      : typeof error === "object" && error && "name" in error
        ? String((error as { name?: unknown }).name ?? "")
        : "";
  return ALLOWED_ERROR_NAMES.has(raw) ? raw : "other";
}

/** One-way hash over the error's structural shape (class + path-stripped stack). */
function errorFingerprint(name: string, error: unknown): string {
  const stack = error instanceof Error ? error.stack : undefined;
  const normalized = (stack ?? "")
    .split("\n")
    .slice(0, 15)
    .map((raw) => {
      // Reduce each V8 frame to its function name only. The `(loc:line:col)`
      // shape validates it's a real frame; the location (path/URL, and any
      // colons it carries), the line, and the column are all discarded. Line
      // numbers shift every build, so omitting them lets the same bug group
      // across releases — at the cost of coarser grouping (distinct bugs in one
      // function share a fingerprint). Message lines (no leading "at ") and
      // anonymous frames (no function name) contribute nothing.
      const line = raw.trim();
      if (!line.startsWith("at ")) return "";
      const withFn = line.match(/^at\s+(.+?)\s+\(.*:\d+:\d+\)\s*$/);
      return withFn ? withFn[1].trim() : "";
    })
    .filter(Boolean)
    .join("|");
  return hashString(`${name}#${normalized}`);
}

/**
 * Grouping key for an engine session error, which arrives over SSE as a plain
 * `{ name, data }` object rather than a thrown Error and so carries no stack
 * for `errorFingerprint` to hash.
 *
 * Hashes the error's SHAPE — its raw class name plus the KEYS of its data bag,
 * never the values. A `message`, `responseBody` or `providerID` value can hold
 * document or user content; the key names are constants from the engine's own
 * schema. Keeps the module guarantee: allowlist + hash + enums + numbers.
 */
export function sessionErrorFingerprint(error: unknown): string | null {
  try {
    if (error instanceof Error) return errorFingerprint(allowlistedErrorName(error), error);
    if (!error || typeof error !== "object") return null;
    const record = error as { name?: unknown; data?: unknown };
    const name = typeof record.name === "string" ? record.name : "";
    const data = record.data && typeof record.data === "object" ? record.data : null;
    const shape = data ? Object.keys(data).sort().join(",") : "";
    if (!name && !shape) return null;
    return hashString(`session:${name}#${shape}`);
  } catch {
    return null;
  }
}

/** Report an error the app caught. Never throws. */
export function captureAppError(source: AppErrorSource, error: unknown): void {
  reportError(error, { source });
}

// The desktop app keeps this window's console errors in main.log for support,
// but Chromium's own "Uncaught …" line there carries no stack.
function describeForLog(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let installed = false;
/**
 * Log uncaught errors with their stack (for main.log and support bundles).
 * Reporting them is done by Sentry's own window handlers. Idempotent.
 */
export function initErrorAnalytics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    // Resource-load failures fire "error" with no `error` object — skip them.
    if (!(event instanceof ErrorEvent) || !event.error) return;
    console.error("Uncaught error:", describeForLog(event.error));
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled rejection:", describeForLog(event.reason));
  });
}
