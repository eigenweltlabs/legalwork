// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Typed errors + translation of upstream SOAP-flavoured messages
 * into actionable English. Per CONNECTORS.md "graceful degradation"
 * and mcp-builder "actionable error messages".
 */

export class RisError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RisError";
    this.code = code;
    this.details = details;
  }
}

export class RisValidationError extends RisError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_error", message, details);
    this.name = "RisValidationError";
  }
}

export class RisNotFoundError extends RisError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, details);
    this.name = "RisNotFoundError";
  }
}

export class RisRateLimitError extends RisError {
  constructor(cooldownMs: number) {
    super(
      "rate_limited",
      `Rate limit exceeded. Wait ${Math.ceil(cooldownMs / 1000)}s before retrying. The RIS upstream requires ~1–2s between paginated calls; the server enforces this.`,
      { cooldown_ms: cooldownMs },
    );
    this.name = "RisRateLimitError";
  }
}

export class RisBulkFetchRefused extends RisError {
  constructor(estimatedRecords: number, threshold: number) {
    super(
      "bulk_fetch_refused",
      `Request would fetch ~${estimatedRecords} records, exceeding the ${threshold} threshold. To proceed: set bulk_acknowledged=true. The RIS FAQ asks operators to notify ris.it@bka.gv.at before mass downloads and to run them outside business hours (20:00–05:00 Austrian local time) or weekends. The acknowledgement is a contract, not a free pass.`,
      { estimated_records: estimatedRecords, threshold },
    );
    this.name = "RisBulkFetchRefused";
  }
}

export class RisUpstreamError extends RisError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("upstream_error", message, details);
    this.name = "RisUpstreamError";
  }
}

/**
 * Translate a soap:Client.* message from the RIS upstream into an
 * actionable English message with a concrete next step.
 */
export function translateUpstreamError(raw: string, applikation?: string): RisError {
  const msg = raw.replace(/^soap:Client[.: ]*/i, "").trim();

  // Wildcard rule violations.
  if (/enthält zu wenige Zeichen vor oder nach dem Platzhalter/i.test(msg)) {
    return new RisValidationError(
      `Wildcard '*' needs at least 2 characters on each side. Upstream: "${msg}"`,
      { upstream_message: msg },
    );
  }

  // Pagination overrun.
  if (/Seitennummer ist höher als die Anzahl der verfügbaren Seiten/i.test(msg)) {
    return new RisValidationError(
      `Requested page is past the last page of results. Reduce 'offset' or call ris_get_history if you want change tracking. Upstream: "${msg}"`,
      { upstream_message: msg },
    );
  }

  // Schema validation — enumeration constraint failed.
  if (/Enumeration constraint failed/i.test(msg)) {
    return new RisValidationError(
      `An enum value was rejected upstream. Call ris_list_scopes with the offending field to get valid values. Upstream: "${msg}"`,
      { upstream_message: msg, applikation },
    );
  }

  // Schema validation — wrong applikation for controller.
  if (/has invalid child element/i.test(msg)) {
    return new RisValidationError(
      `Applikation '${applikation ?? "?"}' is not valid for this controller. Check ris_about for valid controller/applikation combinations. Upstream: "${msg}"`,
      { upstream_message: msg, applikation },
    );
  }

  // Generic schema validation.
  if (/Schema Validation Error/i.test(msg)) {
    return new RisValidationError(
      `Request failed RIS schema validation. Inputs may not match the application's expected param set. Upstream: "${msg}"`,
      { upstream_message: msg, applikation },
    );
  }

  // Fallback.
  return new RisUpstreamError(`RIS upstream error: ${msg}`, { upstream_message: msg, applikation });
}

/** HTTP-error fallback. */
export function upstreamHttpError(status: number, body: string): RisError {
  if (status === 500) {
    return new RisUpstreamError(
      "RIS upstream returned HTTP 500. Try again in 30s; persistent failures suggest a backend incident at the Bundeskanzleramt.",
      { status, body },
    );
  }
  if (status === 404) {
    return new RisNotFoundError("Requested RIS resource not found.", { status });
  }
  return new RisUpstreamError(`RIS upstream HTTP ${status}.`, { status, body });
}
