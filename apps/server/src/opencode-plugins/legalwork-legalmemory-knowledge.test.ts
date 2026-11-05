import { afterEach, describe, expect, test } from "bun:test";
import LegalMemory from "./legalwork-legalmemory-knowledge.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const runtimes: Array<ReturnType<typeof nativePluginTestRuntime>> = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); });
async function memoryRuntime(statuses: Record<string, { status: string }> = {}) {
  const runtime = nativePluginTestRuntime("/project/firm");
  runtime.mcp(statuses);
  runtimes.push(runtime);
  await runtime.start(LegalMemory);
  return runtime;
}
async function prompt(runtime: Awaited<ReturnType<typeof memoryRuntime>>, sessionID = "ses_1") {
  const event = { sessionID, messageID: "msg_user", prompt: { text: "" } };
  await runtime.hook("session", "prompt", event);
  return event.prompt.text.trim();
}
function text(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.map(part => part?.type === "text" ? part.text : "").join("\n") : "";
}

describe("native LegalMemory awareness", () => {
  test("keeps complete use-first and source-citation guidance in durable reminders", async () => {
    const runtime = await memoryRuntime({ legalmemory: { status: "connected" } });
    const reminder = await prompt(runtime);
    expect(reminder).toStartWith('<system-reminder topic="legalmemory">');
    expect(reminder).toContain("SEARCH LEGALMEMORY FIRST");
    expect(reminder).toContain("Do NOT search LegalMemory for a direct, fully specified edit");
    expect(reminder).toContain("[<document title>](legalmemory://document/<document_id>)");
    expect(reminder).toContain('DO NOT write your own "Sources"');
    expect(await prompt(runtime)).toBe("");
    expect(runtime.mcpRequests.every(input => JSON.stringify(input) === JSON.stringify({ location: { directory: "/project/firm" } }))).toBe(true);
  });

  test("recognizes the appliance's own sample name and respects the current location", async () => {
    const runtime = await memoryRuntime({ "knowledge-index": { status: "connected" } });
    runtime.move("/project/other");
    expect(await prompt(runtime)).toContain("LegalMemory is connected");
    expect(runtime.mcpRequests.at(-1)).toEqual({ location: { directory: "/project/other" } });
  });

  test("does not invent availability from an empty or unauthenticated MCP catalog", async () => {
    const runtime = await memoryRuntime({ legalmemory: { status: "needs_auth" }, notion: { status: "connected" } });
    expect(await prompt(runtime)).toBe("");
    runtime.mcp({});
    expect(await prompt(runtime)).toBe("");
    runtime.failMcp(new Error("unavailable"));
    expect(await prompt(runtime)).toBe("");
  });

  test("revokes tools mid-turn and reports disconnect while other work remains available", async () => {
    const statuses = { legalmemory: { status: "connected" } }, runtime = await memoryRuntime(statuses);
    const call = { ...nativeTestInvocation("ses_1"), tool: "legalmemory_get_document", input: {} };
    await runtime.hook("tool", "execute.before", call);
    await prompt(runtime);
    statuses.legalmemory.status = "disabled";
    await expect(runtime.hook("tool", "execute.before", call)).rejects.toThrow("disconnected");
    const result = { sessionID: "ses_1", tool: "storage_search", status: "completed", result: { content: "search done" } };
    await runtime.hook("tool", "execute.after", result);
    expect(text(result.result.content)).toContain("LegalMemory is no longer connected");
    await expect(runtime.hook("tool", "execute.before", { ...call, tool: "grep" })).resolves.toBeUndefined();
    statuses.legalmemory.status = "connected";
    await expect(runtime.hook("tool", "execute.before", call)).resolves.toBeUndefined();
  });

  test("fails closed on status errors without publishing a false disconnect", async () => {
    const runtime = await memoryRuntime();
    runtime.failMcp(new Error("unavailable"));
    expect(await prompt(runtime)).toBe("");
    for (const tool of ["knowledge-index_list_matters", "knowledge_index_list_matters"]) {
      await expect(runtime.hook("tool", "execute.before", { ...nativeTestInvocation(), tool, input: {} })).rejects.toThrow("disconnected");
    }
  });

  test("keeps large JSON pages lossless and searchable while retaining native attachments", async () => {
    const runtime = await memoryRuntime();
    const value = { results: Array.from({ length: 100 }, (_, index) => ({ id: `matter-${index}`, title: `MAT-00005 / ${index}`, summary: "Verträge und Gebühren ".repeat(80) })), page: { total: 100 } };
    const compact = JSON.stringify(value);
    expect(Buffer.byteLength(compact)).toBeGreaterThan(65536);
    const attachment = { type: "file", mime: "image/png", uri: "data:image/png;base64,YQ==" };
    const event = { sessionID: "ses_1", tool: "legalmemory_list_matters", status: "completed", result: { content: [{ type: "text", text: compact }, attachment] } };
    await runtime.hook("tool", "execute.after", event);
    const formatted = text(event.result.content);
    expect(JSON.parse(formatted)).toEqual(value);
    expect(formatted.split("\n").filter(line => line.includes("MAT-00005"))).toHaveLength(100);
    expect(event.result.content[1]).toEqual(attachment);
  });

  test("preserves non-JSON output and unrelated connector output", async () => {
    const runtime = await memoryRuntime();
    const value = "plain text ".repeat(10000);
    const event = { sessionID: "ses_1", tool: "legalmemory_get_document", status: "completed", result: { content: value } };
    await runtime.hook("tool", "execute.after", event);
    expect(event.result.content).toBe(value);
    const other = { sessionID: "ses_1", tool: "other_tool", status: "completed", result: { content: JSON.stringify({ value }) } };
    const before = other.result.content;
    await runtime.hook("tool", "execute.after", other);
    expect(other.result.content).toBe(before);
  });
});
