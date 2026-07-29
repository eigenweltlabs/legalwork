import { describe, expect, test } from "bun:test";

import { buildLegalMemoryRefPrompt, LEGALMEMORY_URI_PATTERN, parseLegalMemoryRef } from "../src/components/markdown/legalmemory-ref";

describe("LegalMemory reference links", () => {
  test("parses document and matter URIs", () => {
    expect(parseLegalMemoryRef("legalmemory://document/8f3a4c2e-1b0d-4e5f-9a7b-2c1d3e4f5a6b")).toEqual({
      kind: "document",
      id: "8f3a4c2e-1b0d-4e5f-9a7b-2c1d3e4f5a6b",
    });
    expect(parseLegalMemoryRef("legalmemory://matter/abc-123")).toEqual({ kind: "matter", id: "abc-123" });
  });

  test("tolerates missing slashes, trailing slash, and case", () => {
    expect(parseLegalMemoryRef("legalmemory:document/abc")).toEqual({ kind: "document", id: "abc" });
    expect(parseLegalMemoryRef("LegalMemory://Matter/abc/")).toEqual({ kind: "matter", id: "abc" });
  });

  test("rejects other schemes, kinds, and malformed ids", () => {
    expect(parseLegalMemoryRef("https://example.com/document/abc")).toBeNull();
    expect(parseLegalMemoryRef("legalmemory://billing/abc")).toBeNull();
    expect(parseLegalMemoryRef("legalmemory://document/")).toBeNull();
    expect(parseLegalMemoryRef("legalmemory://document/a b")).toBeNull();
    expect(parseLegalMemoryRef("reports/summary.md")).toBeNull();
  });

  test("URI pattern matches only the legalmemory scheme", () => {
    expect(LEGALMEMORY_URI_PATTERN.test("legalmemory://document/abc")).toBe(true);
    expect(LEGALMEMORY_URI_PATTERN.test("https://example.com")).toBe(false);
    expect(LEGALMEMORY_URI_PATTERN.test("reports/summary.md")).toBe(false);
  });

  test("document prompt carries the id and drives the export round-trip", () => {
    const prompt = buildLegalMemoryRefPrompt({ kind: "document", id: "doc-1" }, "SPA (final)");
    expect(prompt).toContain('"SPA (final)"');
    expect(prompt).toContain("document_id doc-1");
    expect(prompt).toContain("download_document");
    expect(prompt).toContain("save_command");
  });

  test("matter prompt asks for a preview and falls back to the id label", () => {
    const prompt = buildLegalMemoryRefPrompt({ kind: "matter", id: "m-9" }, "");
    expect(prompt).toContain("matter_id m-9");
    expect(prompt).toContain("id m-9");
    expect(prompt).toContain("preview");
  });
});
