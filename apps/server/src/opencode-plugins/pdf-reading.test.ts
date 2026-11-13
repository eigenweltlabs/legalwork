import { expect, test } from "bun:test";
import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import type { Info, Result } from "@opencode/plugin/promise/tool";
import { pdfReading } from "./pdf-reading.js";
import { extractPdfText } from "../document-preparation/render.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const document = await PDFDocument.create();
for (const marker of ["First page only", "Second page only"]) document.addPage().drawText(marker);
const pdfBytes = await document.save();
const pdfFile = { type: "file", mime: "application/pdf", uri: `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`, name: "scan.pdf" } satisfies Exclude<Result["content"], string | undefined>[number];
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
    return response ? response(request) : Response.json({ source_hash: "fixture", page_count: 2, extraction: "native", complete: true, pages: [{ page: 2, text: "Native contract marker", embedded_text_chars: 22, extraction: "native" }] });
  } });
  process.env.LEGALWORK_SERVER_URL = host.url.origin;
  try { await run(calls); } finally { host.stop(true); if (previous === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previous; }
}

test("native reader advertises PDF options while retaining its path and ordinary execution", async () => {
  const env = await setup();
  expect(JSON.stringify(env.tool.input)).toContain('"ocr"');
  expect(JSON.stringify(env.tool.input)).toContain('"attach"');
  expect(JSON.stringify(env.tool.input)).toContain('"text"');
  expect(JSON.stringify(env.tool.input)).toContain('"path"');
  expect(JSON.stringify(env.tool.input)).not.toContain('"filePath"');
  expect(JSON.stringify(env.tool.input)).toContain("Does not select PDF pages");
  expect(JSON.stringify(env.tool.input)).toContain("Never runs automatically");
  const original = { content: "1: Ordinary file", output: { type: "text-page", content: "Ordinary file" }, metadata: { marker: true } };
  env.result(original);
  expect(await env.call({ path: "/project/notes.txt", offset: 2, limit: 10 })).toBe(original);
  env.execute(async () => { throw new Error("Permission denied"); });
  await expect(env.call()).rejects.toThrow("Permission denied");
});

test("PDF text is the default for every model and forwards selected pages without attaching bytes", async () => server(async calls => {
  for (const supportsPdf of [true, false]) {
    const env = await setup(supportsPdf);
    const result = await env.call({ path: "/project/scan.pdf", pages: [2] });
    expect(result.output).toMatchObject({ text: "[Page 2]\nNative contract marker", pages: [2] });
    expect(typeof result.content === "string" ? [] : result.content?.filter(item => item.type === "file")).toEqual([]);
  }
  for (const call of calls) expect(await call.json()).toMatchObject({ pages: [2] });
}));

test("explicit attachment routing uses the primary model and ignores auxiliary models", async () => server(async calls => {
  for (const supportsPdf of [true, false]) {
    const env = await setup(supportsPdf);
    for (const kind of ["title", "compaction", "generate"]) {
      await env.model(!supportsPdf, kind);
      if (!supportsPdf) {
        expect((await env.call({ path: "/project/scan.pdf", attach: true })).output).toMatchObject({ ok: false, code: "pdf_model_unsupported" });
        continue;
      }
      const result = await env.call({ path: "/project/scan.pdf", attach: true });
      const files = typeof result.content === "string" ? [] : result.content?.filter(item => item.type === "file");
      expect(files).toEqual(supportsPdf ? [pdfFile] : []);
      expect(JSON.stringify(result.output)).toContain("PDF supplied directly");
      expect(result.metadata?.loaded).toEqual(["instructions"]);
    }
    await env.model(!supportsPdf);
    if (supportsPdf) expect((await env.call({ path: "/project/scan.pdf", attach: true })).output).toMatchObject({ ok: false, code: "pdf_model_unsupported" });
    else expect(JSON.stringify((await env.call({ path: "/project/scan.pdf", attach: true })).output)).toContain("PDF supplied directly");
  }
  expect(calls).toHaveLength(0);
}));

test("explicit OCR returns selected text without a PDF attachment", async () => server(async calls => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", ocr: true, pages: [2] });
  expect(result.output).toMatchObject({ text: "[Page 2]\nRecognized text", pages: [2] });
  expect(typeof result.content === "string" ? [] : result.content?.filter(item => item.type === "file")).toEqual([]);
  expect(await calls[0]!.json()).toMatchObject({ ocr: true, pages: [2] });
}, () => Response.json({ source_hash: "fixture", page_count: 2, extraction: "ocr", complete: true, pages: [{ page: 2, text: "Recognized text", embedded_text_chars: 0, extraction: "ocr" }] })));

test("failed OCR reports the error without falling back to attaching the PDF", async () => server(async calls => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", ocr: true, pages: [2] });
  expect(result.output).toMatchObject({ ok: false, attached: false, code: "pdf_ocr_unavailable", message: "Unavailable. Configure OCR in Settings before retrying.", requested: { text: false, ocr: true, attach: false, pages: [2] } });
  expect(JSON.stringify(result.content)).not.toContain("data:application/pdf");
  expect(await calls[0]!.json()).toMatchObject({ ocr: true, pages: [2] });
}, () => Response.json({ code: "pdf_ocr_unavailable", message: "Unavailable. Configure OCR in Settings before retrying." }, { status: 503 })));

test("text reads report scans and recovery options independently of text pagination", async () => server(async () => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", text: true, limit: 1 });
  expect(result.output).toMatchObject({ complete: false, attached: false, ocr_requested: false,
    pages_without_embedded_text: [2], page_sources: [{ page: 1, extraction: "native", embedded_text_chars: 11 }, { page: 2, extraction: "native", embedded_text_chars: 0 }],
    returned_chars: 1, truncated: true, next_offset: 1 });
  expect(JSON.stringify(result.output)).toContain("OCR was not requested and did not run");
  expect(JSON.stringify(result.output)).toContain("ocr=true, attach=true");
}, () => Response.json({ source_hash: "fixture", page_count: 2, extraction: "native", complete: false,
  pages: [{ page: 1, text: "Native text", embedded_text_chars: 11, extraction: "native" }, { page: 2, text: "", embedded_text_chars: 0, extraction: "native" }] })));

test("partial OCR reports page errors and retains embedded-text coverage", async () => server(async () => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", ocr: true });
  expect(result.output).toMatchObject({ complete: false, ocr_requested: true, pages_without_embedded_text: [2],
    page_sources: [{ page: 1, extraction: "ocr", embedded_text_chars: 11 }, { page: 2, extraction: "native", embedded_text_chars: 0 }],
    errors: [{ page: 2, error: "Install the OCR model." }] });
  expect(JSON.stringify(result.output)).toContain("OCR failed");
}, () => Response.json({ source_hash: "fixture", page_count: 2, extraction: "ocr", complete: false,
  pages: [{ page: 1, text: "Recognized text", embedded_text_chars: 11, extraction: "ocr" }, { page: 2, text: "", embedded_text_chars: 0, extraction: "native", error: "Install the OCR model." }] })));

test("timeouts explain page selection and text-only offsets instead of returning a generic error", async () => server(async () => {
  const env = await setup();
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).endsWith("/pdf/read")) throw new DOMException("The operation timed out.", "TimeoutError");
    return original(...args);
  }, original);
  try {
    const result = await env.call({ path: "/project/scan.pdf", ocr: true, pages: [2], limit: 5 });
    expect(result.output).toMatchObject({ ok: false, attached: false, code: "pdf_read_timeout", requested: { ocr: true, pages: [2] } });
    expect(JSON.stringify(result.output)).toContain("offset/limit only paginate returned text");
    expect(JSON.stringify(result.output)).toContain("Select fewer pages");
  } finally { globalThis.fetch = original; }
}));

test("an empty mode selection explains all available modes without contacting extraction", async () => server(async calls => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", text: false, ocr: false, attach: false });
  expect(result.output).toMatchObject({ ok: false, code: "pdf_read_mode" });
  expect(JSON.stringify(result.output)).toContain("text=true");
  expect(JSON.stringify(result.output)).toContain("ocr=true");
  expect(JSON.stringify(result.output)).toContain("attach=true");
  expect(calls).toHaveLength(0);
}));

test("attached page selection returns a real subset PDF with only the requested page", async () => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", attach: true, pages: [2, 2] });
  const files = typeof result.content === "string" ? [] : result.content?.filter(item => item.type === "file");
  expect(files).toHaveLength(1);
  const file = files?.[0]; if (!file || file.type !== "file") throw new Error("Missing selected-page PDF");
  const bytes = new Uint8Array(Buffer.from(file.uri.split(",")[1]!, "base64"));
  const selected = await extractPdfText(bytes, new AbortController().signal);
  expect(selected.pageCount).toBe(1);
  expect(selected.pages[0]?.text).toContain("Second page only");
  expect(selected.pages[0]?.text).not.toContain("First page only");
  expect(result.output).toMatchObject({ page_count: 2, pages: [2] });
  const invalid = await env.call({ path: "/project/scan.pdf", attach: true, pages: [3] });
  expect(invalid.output).toMatchObject({ ok: false, code: "pdf_page" });
  expect(JSON.stringify(invalid.output)).toContain("2 pages");
});

test("oversized attachments return recovery instructions without bytes and page selection can recover", async () => {
  const env = await setup();
  const large = Buffer.concat([pdfBytes, Buffer.alloc(1_600_000, 32)]);
  env.result({ content: [{ ...pdfFile, uri: `data:application/pdf;base64,${large.toString("base64")}` }], output: { type: "file" } });
  const result = await env.call({ path: "/project/scan.pdf", attach: true });
  expect(result.output).toMatchObject({ ok: false, code: "pdf_attachment_too_large", max_attachment_bytes: 2_000_000 });
  expect(JSON.stringify(result.output)).toContain("fewer pages");
  expect(JSON.stringify(result.output)).toContain("OCR");
  expect(JSON.stringify(result.output)).toContain("text");
  expect(JSON.stringify(result.content)).not.toContain("data:application/pdf");
  const recovered = await env.call({ path: "/project/scan.pdf", attach: true, pages: [2] });
  expect(typeof recovered.content === "string" ? [] : recovered.content?.filter(item => item.type === "file")).toHaveLength(1);
});

test("the attachment cap includes base64 overhead at the size boundary", async () => {
  const env = await setup();
  const overhead = Buffer.byteLength(JSON.stringify(pdfFile)) - pdfFile.uri.length + "data:application/pdf;base64,".length;
  const rawLimit = Math.floor((2_000_000 - overhead) / 4) * 3;
  for (const extra of [0, 1]) {
    const bytes = Buffer.concat([pdfBytes, Buffer.alloc(rawLimit + extra - pdfBytes.length, 32)]);
    env.result({ output: { type: "file" }, content: [{ ...pdfFile, uri: `data:application/pdf;base64,${bytes.toString("base64")}` }] });
    const result = await env.call({ path: "/project/scan.pdf", attach: true });
    expect(result.output).toMatchObject(extra ? { attached: false, code: "pdf_attachment_too_large" } : { attached: true });
  }
});

test("combined text and OCR remain labeled, paginated and free of implicit attachments", async () => server(async calls => {
  const env = await setup();
  const result = await env.call({ path: "/project/scan.pdf", text: true, ocr: true, pages: [2] });
  expect(result.output).toMatchObject({ text: "[Page 2 - embedded text]\nNative text\n\n[Page 2 - OCR]\nRecognized text", attached: false });
  expect(JSON.stringify(result.content)).not.toContain("data:application/pdf");
  expect(await calls[0]!.json()).toMatchObject({ text: true, ocr: true, pages: [2] });
}, () => Response.json({ source_hash: "fixture", page_count: 2, extraction: "ocr", complete: true, pages: [{ page: 2, text: "Recognized text", native_text: "Native text", embedded_text_chars: 11, extraction: "ocr" }] })));

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
    const env = await setup(true);
    const first = await env.call({ path: "/project/scan.pdf", offset: 0, limit: 80000 });
    expect(first.output).toMatchObject({ truncated: true, next_offset: 80000 });
    const second = await env.call({ path: "/project/scan.pdf", offset: 80000, limit: 80000 });
    const content = z.object({ text: z.string() });
    expect(content.parse(first.output).text + content.parse(second.output).text).toBe("[Page 1]\n" + text);
    expect(second.output).toMatchObject({ truncated: false });
    expect(calls).toHaveLength(2);
  }, () => Response.json({ source_hash: "fixture", page_count: 1, extraction: "native", complete: true, pages: [{ page: 1, text, embedded_text_chars: text.length, extraction: "native" }] }));
});
