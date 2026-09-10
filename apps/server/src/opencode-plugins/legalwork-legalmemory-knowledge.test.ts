import { describe, expect, test } from "bun:test";
import { LegalWorkLegalMemoryKnowledge } from "./legalwork-legalmemory-knowledge.js";

function statusClient(statuses: Record<string, { status: string }>) {
  return {
    mcp: {
      status: async (_options: { directory?: string }) => ({ data: statuses }),
    },
  };
}

describe("LegalWork LegalMemory knowledge plugin", () => {
  test("pushes the use-LegalMemory-first section when the server is connected", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ legalmemory: { status: "connected" } }),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    const system = output.system.join("\n");
    expect(system).toContain("LegalMemory is connected");
    expect(system).toContain("SEARCH LEGALMEMORY FIRST");
    expect(system).toContain("Do NOT search LegalMemory for a direct, fully specified edit");
    // The markdown-link form, which is what the model measurably emits.
    expect(system).toContain("[<document title>](legalmemory://document/<document_id>)");
    // The interface renders the Sources list, so the model must not write one.
    expect(system).toContain("DO NOT write your own \"Sources\"");
  });

  test("recognizes the appliance's own sample server name", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ "knowledge-index": { status: "connected" } }),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system.join("\n")).toContain("LegalMemory is connected");
  });

  test("stays silent when the server is configured but not connected", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ legalmemory: { status: "needs_auth" }, notion: { status: "connected" } }),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system).toEqual([]);
  });

  test("stays silent when the status check tells us nothing", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({ directory: "/tmp/ws" });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system).toEqual([]);
  });

  test("stays silent when the status map is empty", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({}),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system).toEqual([]);
  });

  test("revokes cached tools and guidance immediately in the same chat", async () => {
    const statuses = { legalmemory: { status: "connected" } };
    const plugin = await LegalWorkLegalMemoryKnowledge({ client: statusClient(statuses) });
    const tool = { tool: "legalmemory_get_document" };
    await plugin["tool.execute.before"](tool);
    await plugin["experimental.chat.system.transform"](null, { system: [] });
    statuses.legalmemory.status = "disabled";
    await expect(plugin["tool.execute.before"](tool)).rejects.toThrow("disconnected");
    const output = { system: [] };
    await plugin["experimental.chat.system.transform"](null, output);
    expect(output.system).toEqual([]);
    await plugin["tool.execute.before"]({ tool: "storage_search" });
    statuses.legalmemory.status = "connected";
    await plugin["tool.execute.before"](tool);
  });

  test("fails closed on status errors and recognizes knowledge-index tools", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      client: { mcp: { status: async () => { throw new Error("unavailable"); } } },
    });
    const output = { system: [] };
    await plugin["experimental.chat.system.transform"](null, output);
    expect(output.system).toEqual([]);
    await expect(plugin["tool.execute.before"]({ tool: "knowledge-index_list_matters" })).rejects.toThrow("disconnected");
    await expect(plugin["tool.execute.before"]({ tool: "knowledge_index_list_matters" })).rejects.toThrow("disconnected");
    await plugin["tool.execute.before"]({ tool: "grep" });
  });

  test("keeps a large matter page searchable without losing any data", async () => {
    const value = { results: Array.from({ length: 100 }, (_, index) => ({
      id: `matter-${index}`, title: `MAT-00005 / ${index}`, summary: "Verträge und Gebühren ".repeat(80),
    })), page: { total: 100 } };
    const text = JSON.stringify(value);
    expect(Buffer.byteLength(text)).toBeGreaterThan(65_536);
    const output = { content: [{ type: "text", text }] };
    const plugin = await LegalWorkLegalMemoryKnowledge();
    await plugin["tool.execute.after"]({ tool: "legalmemory_list_matters" }, output);
    expect(JSON.parse(output.content[0].text)).toEqual(value);
    expect(output.content[0].text.split("\n").filter((line) => line.includes("MAT-00005"))).toHaveLength(100);
    expect(Math.max(...output.content[0].text.split("\n").map((line) => Buffer.byteLength(line)))).toBeLessThan(16_384);
  });

  test("preserves non-JSON output and other MCP results", async () => {
    const text = "plain text ".repeat(10_000);
    const output = { content: [{ type: "text", text }, { type: "image", data: "image" }] };
    const plugin = await LegalWorkLegalMemoryKnowledge();
    await plugin["tool.execute.after"]({ tool: "legalmemory_get_document" }, output);
    expect(output.content[0].text).toBe(text);
    expect(output.content[1].data).toBe("image");
    const other = { content: [{ type: "text", text: JSON.stringify({ text }) }] };
    const before = other.content[0].text;
    await plugin["tool.execute.after"]({ tool: "other_tool" }, other);
    expect(other.content[0].text).toBe(before);
  });
});
