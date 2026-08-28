import { describe, expect, test } from "bun:test";

import { legalMemoryTreeApiUrl, legalMemoryTreeProxyUrl } from "./legalmemory-fetch.js";

describe("LegalMemory tree API URL", () => {
  test("resolves tree routes beside the configured MCP endpoint", () => {
    expect(legalMemoryTreeApiUrl("https://memory.firm.example/mcp/", "/api/tree/roots"))
      .toBe("https://memory.firm.example/api/tree/roots");
    expect(legalMemoryTreeApiUrl("https://firm.example/legalmemory/mcp?ignored=1", "api/tree/search"))
      .toBe("https://firm.example/legalmemory/api/tree/search");
  });

  test("refuses to guess from an unrelated endpoint", () => {
    expect(() => legalMemoryTreeApiUrl("https://memory.firm.example/events", "/api/tree/roots"))
      .toThrow("must end in /mcp");
  });

  test("resolves the hosted demo tree proxy beside MCP", () => {
    expect(legalMemoryTreeProxyUrl("https://memory.firm.example/mcp/", "children"))
      .toBe("https://memory.firm.example/api/tree?op=children");
  });
});
