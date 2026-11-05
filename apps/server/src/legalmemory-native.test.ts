import { expect, test } from "bun:test";
import { fetchLegalMemoryDocument, fetchLegalMemoryTreeRoots, fetchLegalMemoryTreeSearch, resolveLegalMemoryServer, type LegalMemoryClient } from "./legalmemory-fetch.js";
import { LegalMemoryAccessError, legalMemoryRequestSchema } from "./legalmemory-rpc.js";

test("native LegalMemory interface preserves full binary filename, MIME and graph/index payloads", async () => {
  const bytes = Buffer.from("Original binary\u0000".repeat(25_000));
  const client: LegalMemoryClient = {
    tree: async () => { throw new LegalMemoryAccessError("tree_unavailable", "No appliance HTTP tree"); },
    callTool: async (name) => name === "download_document" ? { result: { content: [{ type: "resource", resource: { name: "Original.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", blob: bytes.toString("base64") } }] } }
      : { result: { structuredContent: { results: name === "search_semantic" ? [{ document_id: "document", version_id: "version", title: "Original", source_paths: ["Matter/Original.docx"] }] : [] } } },
  };
  const document = await fetchLegalMemoryDocument(client, "document");
  expect(document.filename).toBe("Original.docx"); expect(document.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document"); expect(Buffer.from(document.bytes).equals(bytes)).toBe(true);
  expect(await fetchLegalMemoryTreeSearch(client, { query: "Original", limit: 100 })).toMatchObject({ files: [{ document_id: "document", name: "Original.docx" }] });
});

test("denied/cancelled native tree operations never retry using another MCP action", async () => {
  for (const code of ["permission_denied", "cancelled", "not_configured"] as const) {
    let calls = 0;
    const client: LegalMemoryClient = { tree: async () => { throw new LegalMemoryAccessError(code, "Explicit refusal"); }, callTool: async () => { calls++; return {}; } };
    await expect(fetchLegalMemoryTreeRoots(client)).rejects.toMatchObject({ code });
    await expect(fetchLegalMemoryTreeSearch(client, { query: "matter", limit: 100 })).rejects.toMatchObject({ code });
    expect(calls).toBe(0);
  }
});

test("LegalMemory RPC has no arbitrary URL, tool name, credential or chat identity input", () => {
  const input = { serverName: "legalmemory", operation: { type: "tree", name: "roots", params: {} } };
  expect(legalMemoryRequestSchema.safeParse(input).success).toBe(true);
  for (const extra of [{ serverUrl: "https://elsewhere.example/mcp" }, { bearer: "forbidden" }, { sessionID: "someone-elses-chat" }, { url: "https://elsewhere.example" }]) expect(legalMemoryRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  expect(legalMemoryRequestSchema.safeParse({ ...input, operation: { type: "tool", name: "delete_document", args: {} } }).success).toBe(false);
  expect(resolveLegalMemoryServer([{ name: "legalmemory", config: { url: "https://firm.example/mcp", disabled: true } }])).toBeNull();
  expect(resolveLegalMemoryServer([{ name: "legalmemory", config: { url: "https://firm.example/mcp", enabled: false } }])).toBeNull();
});
