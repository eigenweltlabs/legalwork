import { expect, test } from "bun:test";
import { createErrorDiagnostic } from "./error-diagnostics.js";
import { ApiError, formatError } from "./errors.js";

test("server response preserves a safe cause before generic error formatting", () => {
  const error = new TypeError("PRIVATE_DOCUMENT_CANARY /Users/Client/Contract.docx");
  const diagnostic = createErrorDiagnostic(error, { component: "server", source: "server_request", operation: "server_request", status_code: 500 });
  const body = formatError(new ApiError(500, "internal_error", "Internal error"), diagnostic);
  expect(body.code).toBe("internal_error");
  expect(body.diagnostic?.error_class).toBe("TypeError");
  expect(body.diagnostic?.status_code).toBe(500);
  expect(body.diagnostic?.incident_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(body)).not.toContain("PRIVATE_DOCUMENT_CANARY");
  expect(JSON.stringify(body)).not.toContain("/Users/");
});
test("an original provider status takes precedence over the generic response status", () => {
  const diagnostic = createErrorDiagnostic({ name: "APIError", data: { statusCode: 400, message: "Invalid request" } }, { status_code: 500 });
  expect(diagnostic.status_code).toBe(400);
  expect(diagnostic.code).toBe("invalid_request");
});
test("existing API envelopes remain backward compatible", () => {
  expect(formatError(new ApiError(401, "authentication", "Authentication failed"))).toEqual({ code: "authentication", message: "Authentication failed", details: undefined });
});
