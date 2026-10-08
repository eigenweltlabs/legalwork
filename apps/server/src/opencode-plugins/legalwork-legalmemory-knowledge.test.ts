import { describe, expect, test } from "bun:test";
import { LegalWorkLegalMemoryKnowledge } from "./legalwork-legalmemory-knowledge.js";

function statusClient(statuses: Record<string, { status: string }>) {
  return {
    mcp: {
      status: async (_options: { directory?: string }) => ({ data: statuses }),
    },
  };
}

type Plugin = Awaited<ReturnType<typeof LegalWorkLegalMemoryKnowledge>>;

/** The reminder text a new user message receives, "" when none. */
async function userMessageReminder(plugin: Plugin, sessionID = "ses_1") {
  const output: { message: { id: string }; parts: object[] } = { message: { id: "msg_1" }, parts: [] };
  await plugin["chat.message"]({ sessionID }, output);
  return output.parts.map((part) => String(Reflect.get(part, "text"))).join("\n");
}

describe("LegalWork LegalMemory knowledge plugin", () => {
  test("reports the use-LegalMemory-first section as a reminder, never in the system prompt", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ legalmemory: { status: "connected" } }),
    });
    expect("experimental.chat.system.transform" in plugin).toBe(false);

    const reminder = await userMessageReminder(plugin);
    expect(reminder).toStartWith('<system-reminder topic="legalmemory">');
    expect(reminder).toContain("LegalMemory is connected");
    expect(reminder).toContain("SEARCH LEGALMEMORY FIRST");
    expect(reminder).toContain("Do NOT search LegalMemory for a direct, fully specified edit");
    // The markdown-link form, which is what the model measurably emits.
    expect(reminder).toContain("[<document title>](legalmemory://document/<document_id>)");
    // The interface renders the Sources list, so the model must not write one.
    expect(reminder).toContain("DO NOT write your own \"Sources\"");
    // Reported once: an unchanged connection adds nothing to later messages.
    expect(await userMessageReminder(plugin)).toBe("");
  });

  test("recognizes the appliance's own sample server name", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ "knowledge-index": { status: "connected" } }),
    });
    expect(await userMessageReminder(plugin)).toContain("LegalMemory is connected");
  });

  test("stays silent when the server is configured but not connected", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ legalmemory: { status: "needs_auth" }, notion: { status: "connected" } }),
    });
    expect(await userMessageReminder(plugin)).toBe("");
  });

  test("stays silent when the status check tells us nothing", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({ directory: "/tmp/ws" });
    expect(await userMessageReminder(plugin)).toBe("");
  });

  test("stays silent when the status map is empty", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({}),
    });
    expect(await userMessageReminder(plugin)).toBe("");
  });

  test("revokes cached tools and guidance immediately in the same chat", async () => {
    const statuses = { legalmemory: { status: "connected" } };
    const plugin = await LegalWorkLegalMemoryKnowledge({ client: statusClient(statuses) });
    const tool = { tool: "legalmemory_get_document" };
    await plugin["tool.execute.before"](tool);
    expect(await userMessageReminder(plugin)).toContain("LegalMemory is connected");
    statuses.legalmemory.status = "disabled";
    await expect(plugin["tool.execute.before"](tool)).rejects.toThrow("disconnected");
    // The disconnect reaches the model on the next tool result of the same run.
    const result = { output: "search done" };
    await plugin["tool.execute.after"]({ tool: "storage_search", sessionID: "ses_1" }, result);
    expect(result.output).toStartWith('search done\n\n<system-reminder topic="legalmemory">');
    expect(result.output).toContain("LegalMemory is no longer connected");
    await plugin["tool.execute.before"]({ tool: "storage_search" });
    statuses.legalmemory.status = "connected";
    await plugin["tool.execute.before"](tool);
  });

  test("fails closed on status errors without reporting a change", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      client: { mcp: { status: async () => { throw new Error("unavailable"); } } },
    });
    expect(await userMessageReminder(plugin)).toBe("");
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
