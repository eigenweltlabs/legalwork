import { describe, expect, test } from "bun:test";

import { allowlistedErrorName, sessionErrorFingerprint } from "../src/app/lib/app-error";
import { analyticsErrorStatus } from "../src/app/lib/analytics-error";

/** The wire shape the engine sends over SSE — a plain object, not an Error. */
const apiError = (data: Record<string, unknown>) => ({ name: "APIError", data });

describe("engine error classification", () => {
  test("names the engine's own wire types instead of bucketing them to other", () => {
    // Both arrived as "other" before: the allowlist carried the client class
    // spelling "ApiError", and UnknownError was missing outright.
    expect(allowlistedErrorName(apiError({ message: "x", isRetryable: false }))).toBe("APIError");
    expect(allowlistedErrorName({ name: "UnknownError", data: { message: "x" } })).toBe("UnknownError");
  });

  test("still refuses a name that is not a known constant", () => {
    expect(allowlistedErrorName({ name: "Error: /Users/anna/matter-4182/claim.docx" })).toBe("other");
  });

  test("reads the HTTP status the engine puts on data.statusCode", () => {
    expect(analyticsErrorStatus(apiError({ message: "x", statusCode: 429, isRetryable: true }))).toBe(429);
    expect(analyticsErrorStatus({ cause: apiError({ message: "x", statusCode: 503, isRetryable: true }) })).toBe(503);
  });

  test("keeps reading the shapes it already understood", () => {
    expect(analyticsErrorStatus({ status: 401 })).toBe(401);
    expect(analyticsErrorStatus({ response: { status: 500 } })).toBe(500);
    expect(analyticsErrorStatus({ name: "UnknownError", data: { message: "x" } })).toBeNull();
  });
});

describe("sessionErrorFingerprint", () => {
  test("groups failures of the same shape and separates different ones", () => {
    const a = sessionErrorFingerprint(apiError({ message: "upstream timed out", statusCode: 504, isRetryable: true }));
    const b = sessionErrorFingerprint(apiError({ message: "rate limited", statusCode: 429, isRetryable: true }));
    const other = sessionErrorFingerprint({ name: "UnknownError", data: { message: "rate limited" } });

    expect(a).toBeTruthy();
    expect(a).toBe(b!); // same shape, different values -> one bucket
    expect(a).not.toBe(other!); // different error type -> its own bucket
  });

  test("never carries the error's content", () => {
    const secret = "Mandant Klug Digital GmbH, Az. 4182/26";
    const print = sessionErrorFingerprint({
      name: "UnknownError",
      data: { message: secret, responseBody: secret, providerID: "klug-digital" },
    })!;

    expect(print).toBeTruthy();
    for (const word of ["Klug", "Digital", "GmbH", "4182", "Mandant", "klug-digital"]) {
      expect(print).not.toContain(word);
    }
    // Opaque, fixed-width-ish hash rather than anything reconstructible.
    expect(print).toMatch(/^[0-9a-z]{1,13}$/);
  });

  test("a data bag's key order does not split a bucket", () => {
    const one = sessionErrorFingerprint({ name: "APIError", data: { message: "a", statusCode: 1, isRetryable: true } });
    const two = sessionErrorFingerprint({ name: "APIError", data: { isRetryable: true, statusCode: 2, message: "b" } });
    expect(one).toBe(two!);
  });

  test("returns null for errors with no shape to hash", () => {
    expect(sessionErrorFingerprint(undefined)).toBeNull();
    expect(sessionErrorFingerprint("boom")).toBeNull();
    expect(sessionErrorFingerprint({})).toBeNull();
  });

  test("falls back to the stack fingerprint for a real thrown Error", () => {
    expect(sessionErrorFingerprint(new TypeError("bad"))).toBeTruthy();
  });
});
