import { describe, expect, test } from "bun:test";

import { isLegalMemoryMcpName } from "../src/app/lib/legalmemory-connection";

describe("LegalMemory MCP identity", () => {
  test("matches every server name accepted by the LegalMemory routes", () => {
    expect(isLegalMemoryMcpName("legalmemory")).toBe(true);
    expect(isLegalMemoryMcpName("legal-memory")).toBe(true);
    expect(isLegalMemoryMcpName("legal_memory")).toBe(true);
    expect(isLegalMemoryMcpName("knowledge-index")).toBe(true);
    expect(isLegalMemoryMcpName("knowledge_index")).toBe(true);
  });

  test("does not reset Drive for unrelated MCP removals", () => {
    expect(isLegalMemoryMcpName("notion")).toBe(false);
  });
});
