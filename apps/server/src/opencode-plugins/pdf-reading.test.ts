import { expect, test } from "bun:test";
import { z } from "zod";
import type { Info, Result } from "@opencode/plugin/promise/tool";
import { pdfReading } from "./pdf-reading.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const pdfFile = { type: "file", mime: "application/pdf", uri: "data:application/pdf;base64,JVBERi0=", name: "scan.pdf" } satisfies Exclude<Result["content"], string | undefined>[number];
async function setup(supportsPdf = true) {
  const runtime = nativePluginTestRuntime("/project");
  let nativeResult: Result = { content: [pdfFile], output: { type: "file" }, metadata: { loaded: ["instructions"] } };
  let execute = async (_input: unknown): Promise<Result> => nativeResult;
  const ctx = new Proxy(runtime.ctx, { get(target, property, receiver) {
    if (property === "model") return { list: async () => ({ data: [{ providerID: "fixture", id: "pdf", capabilities: { input: ["text", "pdf"] } }, { providerID: "fixture", id: "text", capabilities: { input: ["text"] } }] }) };
    if (property === "tool") return { ...target.tool, transform: async (callback: Parameters<typeof target.tool.transform>[0]) => target.tool.transform(editor => callback(new Proxy(editor, { get(value, key, receiver) {
      if (key === "update") return (id: string, update: (tool: Info) => void) => { const tool = runtime.tools.get(id); if (tool) update(tool); };
      return Reflect.get(value, key, receiver);
    } }))) };
    return Reflect.get(target, property, receiver);
  } });
  await ctx.tool.transform(editor => editor.add({ name: "read", description: "Native read.", input: { type: "object" }, async execute(input) { return execute(input); } }));
  const plugin = pdfReading(); await plugin.register(ctx);
  const model = async (pdf: boolean, kind = "primary") => runtime.hook("session", "model.request", { sessionID: "chat", agent: "build", kind, model: { providerID: "fixture", id: pdf ? "pdf" : "text" } });
  await model(supportsPdf);
  const tool = runtime.tools.get("read"); if (!tool) throw new Error("Read tool missing");
  return { plugin, runtime, tool, model, result: (next: Result) => { nativeResult = next; }, execute: (next: typeof execute) => { execute = next; }, call: (input: unknown = { path: "/project/scan.pdf" }, signal = new AbortController().signal) => tool.execute(input, nativeTestInvocation("chat", signal)) };
}

async function server(run: (calls: Request[]) => Promise<void>, response?: (request: Request) => Promise<Response> | Response) {
  const previous = process.env.LEGALWORK_SERVER_URL, calls: Request[] = [];
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/workspaces") return Response.json({ items: [{ id: "project", path: "/project" }] });
    calls.push(new Request(request.url, { method: request.method, headers: request.headers, body: await request.clone().text() }));
    return response ? response(request) : Response.json({ source_hash: "fixture", page_count: 2, extraction: "native", complete: true, pages: [{ page: 2, text: "Native contract marker", extraction: "native" }] });
  } });
  process.env.LEGALWORK_SERVER_URL = host.url.origin;
  try { await run(calls); } finally { host.stop(true); if (previous === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previous; }
}

test("native reader advertises PDF options while retaining its path and ordinary execution", async () => {
  const env = await setup();
  expect(JSON.stringify(env.tool.input)).toContain('"ocr"');
  expect(JSON.stringify(env.tool.input)).toContain('"path"');
  expect(JSON.stringify(env.tool.input)).not.toContain('"filePath"');
  const original = { content: "1: Ordinary file", output: { type: "text-page", content: "Ordinary file" }, metadata: { marker: true } };
  env.result(original);
  expect(await env.call({ path: "/project/notes.txt", offset: 2, limit: 10 })).toBe(original);
  env.execute(async () => { throw new Error("Permission denied"); });
  await expect(env.call()).rejects.toThrow("Permission denied");
});

test("PDF routing uses the primary model and ignores title/compaction/generate models", async () => server(async calls => {
  for (const supportsPdf of [true, false]) {
    const env = await setup(supportsPdf);
    for (const kind of ["title", "compaction", "generate"]) {
      await env.model(!supportsPdf, kind);
      const result = await env.call();
      const files = typeof result.content === "string" ? [] : result.content?.filter(item => item.type === "file");
      expect(files).toEqual(supportsPdf ? [pdfFile] : []);
      expect(JSON.stringify(result.output)).toContain(supportsPdf ? "PDF supplied directly" : "Native contract marker");
      expect(result.metadata?.loaded).toEqual(["instructions"]);
    }
    await env.model(!supportsPdf);
    expect(JSON.stringify((await env.call()).output)).toContain(supportsPdf ? "Native contract marker" : "PDF supplied directly");
  }
  expect(calls).toHaveLength(4);
}));

test("explicit OCR preserves PDF attachment and selected pages with actionable failure", async () => server(async calls => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", ocr: true, pages: [2] });
  expect(result.output).toMatchObject({ complete: false, extraction: "pdf", ocr_error: "Unavailable" });
  expect(result.content).toContainEqual(pdfFile);
  expect(await calls[0]!.json()).toMatchObject({ ocr: true, pages: [2] });
}, () => Response.json({ message: "Unavailable" }, { status: 503 })));

test("native tool cancellation stops OCR without returning a success fallback", async () => server(async calls => {
  const env = await setup(); const controller = new AbortController();
  const reading = env.call({ path: "/project/scan.pdf", ocr: true }, controller.signal);
  while (!calls.length) await Bun.sleep(1);
  controller.abort(new Error("Stopped by user"));
  await expect(reading).rejects.toThrow("Stopped by user");
}, request => new Promise(resolve => { request.signal.addEventListener("abort", () => resolve(new Response("Stopped", { status: 499 })), { once: true }); })));


test("PDF text pagination retains every character and reports the continuation exactly", async () => {
  const text = "CONTRACT-" + "x".repeat(90000) + "-DECISIVE-TAIL";
  await server(async calls => {
    const env = await setup(false);
    const first = await env.call({ path: "/project/scan.pdf", offset: 0, limit: 80000 });
    expect(first.output).toMatchObject({ truncated: true, next_offset: 80000 });
    const second = await env.call({ path: "/project/scan.pdf", offset: 80000, limit: 80000 });
    const content = z.object({ text: z.string() });
    expect(content.parse(first.output).text + content.parse(second.output).text).toBe("[Page 1]\n" + text);
    expect(second.output).toMatchObject({ truncated: false });
    expect(calls).toHaveLength(2);
  }, () => Response.json({ source_hash: "fixture", page_count: 1, extraction: "native", complete: true, pages: [{ page: 1, text, extraction: "native" }] }));
});
