/**
 * Content-free error classification for analytics. These helpers only ever
 * return an enum or a number — the error message/stack is inspected to CLASSIFY
 * but is never returned or sent.
 */
import { LegalworkServerError } from "./legalwork-server";

export type AnalyticsErrorService = "opencode" | "server" | "network";

/** The HTTP status code an error carries, or null. Never any content. */
export function analyticsErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown };
  };
  const status = record.status ?? record.response?.status ?? record.cause?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Which backend an error came from. Derived from the error's type/shape and a
 * regex over its message, but only the resulting enum is ever emitted.
 */
export function analyticsErrorService(error: unknown): AnalyticsErrorService {
  if (error instanceof LegalworkServerError) return "server";
  if (analyticsErrorStatus(error) === null) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/failed to fetch|econnrefused|networkerror|err_connection|connection (lost|refused)|timed out|etimedout/i.test(message)) {
      return "network";
    }
  }
  return "opencode";
}
