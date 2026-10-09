import { expect, test } from "bun:test";
import { createFullErrorDetails, fullExceptionList, snapshotErrorDetails } from "@legalwork/types/error-details";

test("manual snapshots retain original stacks, causes, provider bodies and paths while removing credentials", () => {
  const cause = new TypeError("PRIVATE_CONTRACT_CONTENT /Users/Client/Contracts/draft.docx");
  const error = Object.assign(new Error("Provider returned error", { cause }), {
    responseBody: JSON.stringify({ error: { metadata: { raw: "tools.0.input_schema invalid", flagged_input: "PRIVATE_PROMPT" }, api_key: "private-api-key" } }),
    responseHeaders: { "x-request-id": "provider-request-123", authorization: "Bearer secret-auth", "set-cookie": "secret-cookie", "x-api-key": "secret-header-key" },
    apiKey: "sk-or-v1-full-report-secret", url: "https://user:password@example.com/api?api_key=private-query-key",
  });
  const details = createFullErrorDetails(error, { providerId: "custom-provider", modelId: "anthropic/claude-opus-4.6" });
  const json = JSON.stringify(details);
  expect(json).toContain("PRIVATE_CONTRACT_CONTENT"); expect(json).toContain("PRIVATE_PROMPT");
  expect(json).toContain("/Users/Client/Contracts/draft.docx"); expect(json).toContain("provider-request-123");
  expect(json).toContain("custom-provider"); expect(json).toContain("stack");
  for (const secret of ["private-api-key", "secret-auth", "secret-cookie", "secret-header-key", "sk-or-v1-full-report-secret", "private-query-key", "user:password"]) expect(json).not.toContain(secret);
  expect(fullExceptionList(details).map(item => item.type)).toEqual(["TypeError", "Error"]);
});

test("snapshots survive cycles, getters, BigInts and malicious property keys", () => {
  let invoked = false;
  const value = { count: 123n, self: {} };
  value.self = value;
  Object.defineProperty(value, "getter", { enumerable: true, get() { invoked = true; throw new Error("Getter executed"); } });
  Object.defineProperty(value, "__proto__", { enumerable: true, value: { unexpected: true } });
  const snapshot = snapshotErrorDetails(value);
  expect(invoked).toBe(false);
  expect(JSON.stringify(snapshot)).toContain("circular");
  expect(JSON.stringify(snapshot)).toContain("accessor omitted");
  expect(JSON.stringify(snapshot)).toContain('"count":"123"');
  const array = ["ordinary"];
  Object.defineProperty(array, "0", { get() { invoked = true; throw new Error("Array getter executed"); } });
  expect(snapshotErrorDetails(array)).toEqual(["[accessor omitted]"]);
  expect(invoked).toBe(false);
  expect(snapshotErrorDetails(new Map([["requestId", "provider-request"], ["apiKey", "MAP_SECRET"]]))).toEqual([["requestId", "provider-request"], ["apiKey", "<redacted>"]]);
  class ProviderError extends Error {}
  expect(JSON.stringify(snapshotErrorDetails(new ProviderError("failed")))).toContain('"name":"ProviderError"');
  const timeout = JSON.stringify(snapshotErrorDetails(new DOMException("Request exceeded deadline", "TimeoutError")));
  expect(timeout).toContain("TimeoutError"); expect(timeout).toContain("Request exceeded deadline");
});

test("manual stack frames retain full locations and explicitly mark safety truncation", () => {
  const error = new Error("failure");
  error.stack = "Error: failure\n    at send (/Users/Client/Private folder/app.ts:123:45)\nparse@https://app.example/assets/run.js:8:9";
  const frames = fullExceptionList(createFullErrorDetails(error))[0].stacktrace?.frames;
  expect(frames).toEqual([
    { platform: "web:javascript", filename: "https://app.example/assets/run.js", function: "parse", lineno: 8, colno: 9 },
    { platform: "web:javascript", filename: "/Users/Client/Private folder/app.ts", function: "send", lineno: 123, colno: 45 },
  ]);
  expect(JSON.stringify(snapshotErrorDetails({ responseBody: "x".repeat(2_000_001) }))).toContain("truncated");
});
