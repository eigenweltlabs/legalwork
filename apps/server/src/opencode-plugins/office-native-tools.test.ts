import { afterEach, describe, expect, test } from "bun:test";
import Word from "./legalwork-word-tools.js";
import Excel from "./legalwork-excel-tools.js";
import PowerPoint from "./legalwork-powerpoint-tools.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.LEGALWORK_SERVER_URL;
const originalToken = process.env.LEGALWORK_SERVER_TOKEN;
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
  else process.env.LEGALWORK_SERVER_URL = originalUrl;
  if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
  else process.env.LEGALWORK_SERVER_TOKEN = originalToken;
});

async function officeRuntime(hosts = ["word", "excel", "powerpoint"]) {
  process.env.LEGALWORK_SERVER_URL = `http://office-${crypto.randomUUID()}.test`;
  process.env.LEGALWORK_SERVER_TOKEN = "isolated-test-token";
  const calls: Array<{ url: string; body: unknown; signal?: AbortSignal | null }> = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/workspaces")) return Response.json({ items: [{ id: "parent", path: "/matter" }, { id: "nested", path: "/matter/nested" }] });
    if (url.endsWith("/office-tools/status")) return Response.json({ connected: true,
      hosts: hosts.map(host => ({ host, documentUrl: `/matter/nested/Current.${host === "word" ? "docx" : host === "excel" ? "xlsx" : "pptx"}` })) });
    if (url.endsWith("/office-tools/execute")) {
      const body: unknown = JSON.parse(String(options?.body));
      calls.push({ url, body, signal: options?.signal });
      return Response.json({ ok: true, result: { trackedChange: true, highlight: true, body } });
    }
    return new Response("Not found", { status: 404 });
  }, { preconnect: originalFetch.preconnect });
  const runtime = nativePluginTestRuntime("/matter/nested/subfolder");
  stops.push(runtime.close);
  for (const plugin of [Word, Excel, PowerPoint]) await runtime.start(plugin);
  return { runtime, calls };
}

describe("native Office adapters", () => {
  test("registers all 24 tools with object schemas and uses the calling session's nested project", async () => {
    const { runtime, calls } = await officeRuntime();
    expect(runtime.tools.size).toBe(24);
    for (const tool of runtime.tools.values()) expect(Reflect.get(tool.input, "type")).toBe("object");
    const word = runtime.tools.get("word_replace_text");
    expect(word).toBeDefined();
    const result = await word!.execute({ anchor: "Old party", replacement: "New party" }, nativeTestInvocation());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toEndWith("/workspace/nested/office-tools/execute");
    expect(calls[0]?.body).toMatchObject({ tool: "word_replace_text", args: { anchor: "Old party", replacement: "New party" } });
    expect(result.content).toContain('"trackedChange": true');
    expect(runtime.permissions).toMatchObject([{ action: "word_replace_text", resources: ["*"], sessionID: "ses_word" }]);
  });

  test("keeps Excel formulas/highlighting and PowerPoint edits on their existing Office relay", async () => {
    const { runtime, calls } = await officeRuntime();
    await runtime.tools.get("excel_write_cells")!.execute({ start_cell: "B2", values: [["=SUM(B3:B8)"]], as_formulas: true, highlight: true }, nativeTestInvocation());
    await runtime.tools.get("ppt_add_slide")!.execute({}, nativeTestInvocation());
    expect(calls.map(call => call.body)).toMatchObject([
      { tool: "excel_write_cells", args: { start_cell: "B2", values: [["=SUM(B3:B8)"]], as_formulas: true, highlight: true } },
      { tool: "ppt_add_slide", args: {} },
    ]);
  });

  test("reports only the session's connected panes while keeping fixed system instructions", async () => {
    const { runtime } = await officeRuntime(["excel"]);
    const first: { system: unknown[] } = { system: [] };
    await runtime.hook("session", "context", first);
    await runtime.hook("session", "prompt", { sessionID: "ses_word", messageID: "msg_user", prompt: { text: "Summarize the workbook" } });
    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]?.text).toContain("inside Microsoft Excel");
    const second: { system: unknown[] } = { system: [] };
    await runtime.hook("session", "context", second);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("Current.xlsx");
  });

  test("blocks the native shell and subagent DOCX pipeline for a live Word document", async () => {
    const { runtime } = await officeRuntime(["word"]);
    const call = nativeTestInvocation();
    await expect(runtime.hook("tool", "execute.before", { ...call, tool: "shell", input: { command: "node docx-agent.mjs inspect Current.docx" } })).rejects.toThrow("open in Microsoft Word");
    await expect(runtime.hook("tool", "execute.before", { ...call, tool: "subagent", input: { agent: "docx-redliner", prompt: "Redline Current.docx" } })).rejects.toThrow("open in Microsoft Word");
    await expect(runtime.hook("tool", "execute.before", { ...call, tool: "shell", input: { command: "node docx-agent.mjs inspect Other.docx" } })).resolves.toBeUndefined();
  });

  test("cancelling an Office call aborts its HTTP request and preserves the native cancellation", async () => {
    const { runtime } = await officeRuntime();
    const base = globalThis.fetch;
    let requestStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (!String(input).endsWith("/office-tools/execute")) return base(input, options);
      requestStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(options?.signal?.reason);
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    }, { preconnect: base.preconnect });
    const controller = new AbortController();
    const execution = runtime.tools.get("word_replace_text")!.execute({ anchor: "old", replacement: "new" }, nativeTestInvocation("ses_word", controller.signal));
    await started;
    const reason = new Error("User stopped this edit");
    controller.abort(reason);
    await expect(execution).rejects.toBe(reason);
  });
});
