/**
 * Content-free error analytics. `app_error` NEVER carries an error message or
 * stack — only: an allowlisted class name, an opaque one-way fingerprint of the
 * error's structure, the originating service, an HTTP status, and the surface.
 * The guarantee comes from the schema (allowlist + hash + enums), not from
 * scrubbing free-form strings.
 */
import { captureAnalyticsEvent, analyticsSurface, type AnalyticsSurface } from "./analytics";
import { analyticsErrorService, analyticsErrorStatus, type AnalyticsErrorService } from "./analytics-error";

export type AppErrorSource =
  // global (caught automatically in the renderer)
  | "uncaught"
  | "unhandledrejection"
  | "react_render"
  // explicit (fired from subsystem catch blocks)
  | "workspace_create"
  | "provider_connect"
  | "integration_connect"
  | "document_op"
  // main process (relayed from Electron main over IPC)
  | "main_uncaught"
  | "main_unhandledrejection"
  | "sidecar_exit";

type AppErrorService = AnalyticsErrorService | "renderer" | "sidecar";

const GLOBAL_SOURCES = new Set<AppErrorSource>(["uncaught", "unhandledrejection", "react_render"]);

// Only these class names are ever emitted; anything else is bucketed to "other"
// so an unexpected (possibly content-bearing) name never leaves the machine.
const ALLOWED_ERROR_NAMES = new Set([
  // Standard JS / DOM error classes.
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError",
  "URIError", "AggregateError", "DOMException", "AbortError", "NotFoundError",
  "NetworkError", "TimeoutError",
  // App / server error classes.
  "LegalworkServerError", "ApiError",
  // opencode agent / run-failure reasons (the "why a run failed" types).
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
    .map((line) => {
      // Keep only "function:line" — drop file paths/URLs and columns.
      const match = line.match(/at\s+(.+?)\s*\(?.*?:(\d+):\d+\)?\s*$/);
      return match ? `${match[1].trim()}:${match[2]}` : "";
    })
    .filter(Boolean)
    .join("|");
  let hash = 5381;
  const input = `${name}#${normalized}`;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

// Throttle: send each distinct fingerprint at most once per session, and cap
// the total, so a looping error can never flood analytics.
const MAX_ERRORS_PER_SESSION = 20;
const seenFingerprints = new Set<string>();
let sentCount = 0;

type AppErrorFields = {
  source: AppErrorSource;
  error_name: string;
  error_fingerprint: string | null;
  service: AppErrorService;
  status_code: number | null;
  surface: AnalyticsSurface;
};

function emit(fields: AppErrorFields): void {
  const key = `${fields.source}:${fields.error_name}:${fields.error_fingerprint ?? ""}`;
  if (seenFingerprints.has(key)) return;
  if (sentCount >= MAX_ERRORS_PER_SESSION) return;
  seenFingerprints.add(key);
  sentCount += 1;
  captureAnalyticsEvent("app_error", { ...fields });
}

/** Report a renderer error. Never throws. */
export function captureAppError(source: AppErrorSource, error: unknown, service?: AppErrorService): void {
  try {
    const name = allowlistedErrorName(error);
    emit({
      source,
      error_name: name,
      error_fingerprint: errorFingerprint(name, error),
      service: service ?? (GLOBAL_SOURCES.has(source) ? "renderer" : analyticsErrorService(error)),
      status_code: analyticsErrorStatus(error),
      surface: analyticsSurface(),
    });
  } catch {
    // Error reporting must never surface an error itself.
  }
}

/** Report an error relayed from the Electron main process (precomputed, content-free). */
export function captureRelayedAppError(fields: {
  source: AppErrorSource;
  error_name?: string | null;
  service: AppErrorService;
}): void {
  try {
    const name = fields.error_name && ALLOWED_ERROR_NAMES.has(fields.error_name) ? fields.error_name : "other";
    emit({
      source: fields.source,
      error_name: name,
      error_fingerprint: null,
      service: fields.service,
      status_code: null,
      surface: analyticsSurface(),
    });
  } catch {
    // no-op
  }
}

let installed = false;
/** Install global renderer error hooks. Idempotent; safe to call from any root. */
export function initErrorAnalytics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    // Resource-load failures fire "error" with no `error` object — skip them.
    if (!(event instanceof ErrorEvent) || !event.error) return;
    captureAppError("uncaught", event.error);
  });
  window.addEventListener("unhandledrejection", (event) => {
    captureAppError("unhandledrejection", event.reason);
  });
}
