import { describe, expect, test } from "bun:test";

/** Mirrors humanizeEngineError's predicate in mcp-auth-modal.tsx. */
const looksLikePayload = (message: string) => /^\s*[{[]/.test(message) || message.includes('"_tag"');

describe("engine error leakage", () => {
  test("the exact payload users were shown is caught", () => {
    const raw = '{"_tag":"McpServerNotFoundError","name":"legalmemory","message":"MCP server not found: legalmemory"}';
    expect(looksLikePayload(raw)).toBe(true);
  });

  test("other serialized failures are caught too", () => {
    expect(looksLikePayload('{"name":"UnknownError","data":{"ref":"err_e56a6d1e"}}')).toBe(true);
    expect(looksLikePayload('  [{"_tag":"Whatever"}]')).toBe(true);
  });

  test("a real sentence is left alone", () => {
    expect(looksLikePayload("The server refused the connection.")).toBe(false);
    expect(looksLikePayload("Authorization was cancelled in the browser.")).toBe(false);
  });
});
