/**
 * Content-free error analytics. `app_error` NEVER carries an error message or
 * stack — only: an allowlisted class name, an opaque one-way fingerprint of the
 * error's structure, the originating service, an HTTP status, a numeric process
 * exit code (sidecar crashes), and the surface. The guarantee comes from the
 * schema (allowlist + hash + enums + numbers), not from scrubbing free-form
 * strings.
 */
import { captureAnalyticsEvent, analyticsSurface, type AnalyticsSurface } from "./analytics";
import { analyticsErrorService, analyticsErrorStatus, type AnalyticsErrorService } from "./analytics-error";
import { hashString } from "./hash";

export type AppErrorSource =
  // global (caught automatically in the renderer)
  | "uncaught"
  | "unhandledrejection"
  | "react_render"
  // explicit (fired from subsystem catch blocks)
  | "workspace_create"
  | "integration_connect"
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
  // Process exit code for `sidecar_exit` (a signal is encoded as 128 + signal
  // number: 137 = SIGKILL/OOM, 139 = SIGSEGV, ...). null for all other sources.
  exit_code: number | null;
  surface: AnalyticsSurface;
};

function emit(fields: AppErrorFields): void {
  // Include exit_code so distinct sidecar failure modes each record once while a
  // crash loop with the same code is still deduped to one event per session.
  const key = `${fields.source}:${fields.error_name}:${fields.error_fingerprint ?? ""}:${fields.exit_code ?? ""}`;
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
      exit_code: null,
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
  exit_code?: number | null;
}): void {
  try {
    const name = fields.error_name && ALLOWED_ERROR_NAMES.has(fields.error_name) ? fields.error_name : "other";
    emit({
      source: fields.source,
      error_name: name,
      error_fingerprint: null,
      service: fields.service,
      status_code: null,
      exit_code: typeof fields.exit_code === "number" ? fields.exit_code : null,
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
