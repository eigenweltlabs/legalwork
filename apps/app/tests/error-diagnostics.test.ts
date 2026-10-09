import { describe, expect, test } from "bun:test";
import { createErrorDiagnostic } from "@legalwork/types/error-diagnostics";
import { ErrorDiagnosticSchema, errorExceptionProperties } from "@legalwork/types/error-report";
import { createNativeDiagnostic, createNativeIncidentStore } from "../../desktop/electron/error-incidents.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const canary = "CONFIDENTIAL_Anna_anna@example.com_/Users/Anna/client-contract.docx_sk-secret";
const providerError = (message: string, statusCode = 400) => ({ name: "APIError", data: { message, statusCode, isRetryable: false, responseBody: JSON.stringify({ error: { message, metadata: { flagged_input: canary, api_key: canary } } }) } });

describe("content-free diagnostics", () => {
  test("400 stays generic unless an actual schema signature is present", () => {
    expect(createErrorDiagnostic(providerError(canary)).code).toBe("invalid_request");
    expect(createErrorDiagnostic(providerError("Unsupported request parameter: timeout", 400)).code).toBe("invalid_request");
    expect(createErrorDiagnostic(providerError("tools.0.input_schema must not contain anyOf at the top level")).code).toBe("invalid_tool_schema");
    expect(createErrorDiagnostic(providerError("Rejected", 429)).code).toBe("rate_limit");
    expect(createErrorDiagnostic(providerError("Gateway timed out", 504)).code).toBe("timeout");
  });
  test("reads an OpenRouter upstream error without retaining its raw response", () => {
    const error = { name: "APIError", data: { statusCode: 400, responseBody: JSON.stringify({ error: {
      message: "Provider returned error", metadata: { raw: JSON.stringify({ error: { type: "invalid_request_error", message: `tools.0.input_schema must not contain anyOf: ${canary}` } }), flagged_input: canary },
    } }) } };
    const diagnostic = createErrorDiagnostic(error);
    expect(diagnostic.code).toBe("invalid_tool_schema");
    expect(diagnostic.native_code).toBe("invalid_request_error");
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
  });
  test("preserves SDK JSON and nested cause classes before generic formatting", () => {
    const error = new Error(JSON.stringify(providerError("Invalid request")));
    const diagnostic = createErrorDiagnostic(error);
    expect(diagnostic.error_class).toBe("APIError");
    expect(diagnostic.status_code).toBe(400);
    class ApiError extends Error {}
    expect(createErrorDiagnostic(new ApiError(canary)).error_class).toBe("ApiError");
    expect(createErrorDiagnostic(new Error(canary, { cause: new TypeError(canary) })).error_class).toBe("TypeError");
    const cyclic = { name: "Error", cause: {} };
    cyclic.cause = cyclic;
    expect(() => createErrorDiagnostic(cyclic)).not.toThrow();
  });
  test("a custom OpenRouter route is recognized without transmitting its name or URL", () => {
    const error = providerError(canary);
    const diagnostic = createErrorDiagnostic(error, { providerId: canary, baseURL: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-opus-4.6" });
    expect(diagnostic.provider).toBe("openrouter");
    expect(diagnostic.model_family).toBe("claude_opus");
    expect(diagnostic.api_format).toBe("chat_completions");
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
    expect(JSON.stringify(diagnostic)).not.toContain("https://");
  });
  test("only manifest-owned asset locations survive; no stack messages, function names or user paths", () => {
    const error = new TypeError(canary);
    error.stack = `TypeError: ${canary}\n at ${canary} (file:///Users/Anna/app/assets/index-Abcd1234.js:12:34)\n at privatefile (file:///Users/Anna/assets/contract-Abcd1234.js:1:1)`;
    const diagnostic = createErrorDiagnostic(error, { applicationAssets: new Map([["index-Abcd1234.js", "9e5fab4e-05b9-4c81-8194-8f34b28e5ba6"]]) });
    expect(diagnostic.frames).toEqual([{ asset: "index-Abcd1234.js", chunk_id: "9e5fab4e-05b9-4c81-8194-8f34b28e5ba6", line: 12, column: 34 }]);
    const outgoing = errorExceptionProperties(diagnostic);
    expect(outgoing.$exception_list[0].stacktrace?.frames[0].platform).toBe("web:javascript");
    expect(JSON.stringify(outgoing)).not.toContain(canary);
    expect(JSON.stringify(outgoing)).not.toContain("/Users");
    expect(createErrorDiagnostic(error).frames).toEqual([]);
  });
  test("fingerprints distinguish causes without depending on content", () => {
    expect(createErrorDiagnostic(providerError("one", 429)).fingerprint).toBe(createErrorDiagnostic(providerError("two", 429)).fingerprint);
    expect(createErrorDiagnostic(providerError("one", 429)).fingerprint).not.toBe(createErrorDiagnostic(providerError("one", 504)).fingerprint);
  });
  test("strict contracts reject additional fields, including nested user content", () => {
    const diagnostic = createErrorDiagnostic(providerError(canary));
    expect(ErrorDiagnosticSchema.safeParse({ ...diagnostic, message: canary }).success).toBe(false);
    expect(ErrorDiagnosticSchema.safeParse({ ...diagnostic, frames: [{ asset: "index-Abcd1234.js", chunk_id: null, line: 1, column: 1, vars: { text: canary } }] }).success).toBe(false);
  });
  test("native stack locations retain only known application modules", () => {
    const error = new TypeError(canary);
    error.stack = `TypeError: ${canary}\n at privateFunction (${new URL("../../desktop/electron/main.mjs", import.meta.url).href}:123:45)\n at client (/Users/Anna/main.mjs:10:10)`;
    const diagnostic = createNativeDiagnostic("main_uncaught", error);
    expect(ErrorDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    expect(diagnostic.frames).toEqual([{ asset: "main.mjs", chunk_id: null, line: 123, column: 45 }]);
    expect(errorExceptionProperties(diagnostic).$exception_list[0].stacktrace?.frames[0].platform).toBe("node:javascript");
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
    expect(JSON.stringify(diagnostic)).not.toContain("/Users/");
  });
  test("native fatal errors persist safely for the next launch", () => {
    const dir = mkdtempSync(join(tmpdir(), "legalwork-errors-"));
    try {
      const store = createNativeIncidentStore(dir);
      const diagnostic = store.record("sidecar_exit", new Error(canary), { version: "0.12.0", platform: "darwin", exitCode: 1 });
      expect(ErrorDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
      expect(diagnostic.code).toBe("engine_crash");
      expect(readFileSync(join(dir, "error-incidents.json"), "utf8")).not.toContain(canary);
      expect(store.details(diagnostic.incident_id)?.stack).toContain("CONFIDENTIAL_Anna");
      expect(store.details(diagnostic.incident_id)?.message).toContain("/Users/Anna/client-contract.docx");
      expect(createNativeIncidentStore(dir).list()).toEqual([diagnostic]);
      expect(createNativeIncidentStore(dir).details(diagnostic.incident_id)).toBeNull();
      for (let i = 0; i < 35; i++) store.record("main_uncaught", new Error(canary));
      expect(store.list()).toHaveLength(30);
      expect(createNativeDiagnostic("bad_source", new Error(canary))).toBeNull();
      expect(store.details(diagnostic.incident_id)).toBeNull();
      const latest = store.record("main_uncaught", new Error("latest"));
      store.clear(); expect(store.details(latest.incident_id)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
