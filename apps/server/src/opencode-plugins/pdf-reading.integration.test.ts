import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { PdfReader } from "../pdf-reader.js";
import { pdfReadOptions } from "../pdf-read-schema.js";
import { extractPdfText } from "../document-preparation/render.js";
import { OcrService } from "../ocr/service.js";
import { nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";
import { nativeChatResponse } from "./native-domain-engine.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released v2 read and storage reads select PDF pages, require explicit attachments and keep OCR text-only", async () => {
  const ocrPages: number[] = [];
  const reader = new PdfReader({ async serviceSnapshot() { return { fingerprint: "fixture", service: new OcrService([{
    info: { id: "fixture", label: "Fixture", model: "fixture", execution: "local", regions: false, languages: null, warnings: [] },
    async recognize(page) { ocrPages.push(page.pageNumber); return { text: `OCR page ${page.pageNumber} marker`, regions: [], truncated: false }; },
  }], "fixture") }; } });
  const cases = [
    { file: "large-denied.pdf", pdf: true, expected: "permission", deny: true },
    { file: "large.pdf", pdf: true, expected: "Native contract marker" },
    { file: "large.pdf", pdf: true, expected: "pdf_attachment_too_large", attach: true, tooLarge: true },
    { file: "large.pdf", pdf: true, expected: "PDF supplied directly", attach: true, pages: [1] },
    { file: "large.pdf", pdf: false, expected: "Native contract marker" },
    { file: "native.pdf", pdf: true, expected: "Native contract marker" },
    { file: "native.pdf", pdf: true, expected: "PDF supplied directly", attach: true },
    { file: "native.pdf", pdf: true, expected: "PDF supplied directly", attach: true, pages: [2] },
    { file: "scan.pdf", pdf: true, expected: "pages_without_embedded_text", pages: [2] },
    { file: "scan.pdf", pdf: true, expected: "OCR page 2 marker", ocr: true, pages: [2] },
    { file: "native.pdf", pdf: false, expected: "Native contract marker" },
    { file: "scan.pdf", pdf: false, expected: "pages_without_embedded_text", text: true, pages: [2] },
    { file: "scan.pdf", pdf: false, expected: "OCR page 2 marker", ocr: true, pages: [2] },
    { file: "native.pdf", pdf: true, expected: "OCR page 1 marker", ocr: true, pages: [1] },
    { file: "native.pdf", pdf: true, expected: "embedded text", text: true, ocr: true, pages: [1] },
    { file: "denied.pdf", pdf: true, expected: "permission", deny: true },
    { file: "notes.txt", pdf: false, expected: "Ordinary file marker" },
    { file: ".", pdf: false, expected: "notes.txt" },
    { file: ".", pdf: false, expected: "Output truncated", limit: 1 },
    { file: "notes.txt", pdf: false, expected: "Ordinary file marker", offset: 2, limit: 1 },
    { file: "native.pdf", pdf: true, expected: "Native contract marker", storage: true },
    { file: "native.pdf", pdf: true, expected: "PDF supplied directly", storage: true, attach: true, pages: [2] },
    { file: "large.pdf", pdf: true, expected: "pdf_attachment_too_large", storage: true, attach: true, tooLarge: true },
    { file: "native.pdf", pdf: true, expected: "OCR page 1 marker", storage: true, ocr: true, pages: [1] },
    { file: "native.pdf", pdf: false, expected: "Native contract marker", storage: true },
    { file: "scan.pdf", pdf: false, expected: "pages_without_embedded_text", pages: [2], storage: true },
    { file: "scan.pdf", pdf: false, expected: "OCR page 2 marker", ocr: true, pages: [2], storage: true },
  ];
  let scenario = cases[0]!, directory = "", primaryCalls = 0, sequence = 0, pdfRequests = 0;
  const primaryWires: string[] = [];
  const originals = new Map<string, Uint8Array>();
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "fixture", path: directory }] });
    if (url.pathname.endsWith("/checkout")) return Response.json({ localPath: scenario.file, size: 1000, contentType: "application/pdf", version: "original-v1", writable: false });
    if (url.pathname === "/workspace/fixture/pdf/read") {
      pdfRequests++;
      const input = pdfReadOptions.extend({ dataBase64: z.string() }).parse(await request.json());
      return Response.json(await reader.read(new Uint8Array(Buffer.from(input.dataBase64, "base64")), input, request.signal));
    }
    const raw = await request.text();
    const input = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string(), parameters: z.unknown() }) })).optional() }).parse(JSON.parse(raw));
    const read = input.tools?.find(tool => tool.function.name === (scenario.storage ? "storage_read_file" : "read"));
    if (read) {
      primaryWires.push(raw);
      expect(JSON.stringify(read.function.parameters)).toContain('"ocr"');
      expect(JSON.stringify(read.function.parameters)).toContain('"pages"');
      expect(JSON.stringify(read.function.parameters)).toContain('"path"');
      expect(JSON.stringify(read.function.parameters)).toContain('"attach"');
      expect(JSON.stringify(read.function.parameters)).toContain('"text"');
    }
    return nativeChatResponse(read && primaryCalls++ === 0 ? { name: scenario.storage ? "storage_read_file" : "read", input: { path: scenario.storage ? scenario.file : join(directory, scenario.file),
      ...(scenario.storage ? { connection_id: "one" } : {}),
      ...(scenario.attach ? { attach: true } : {}), ...(scenario.text ? { text: true } : {}),
      ...(scenario.ocr ? { ocr: true } : {}), ...(scenario.pages ? { pages: scenario.pages } : {}),
      ...(scenario.offset ? { offset: scenario.offset } : {}), ...(scenario.limit ? { limit: scenario.limit } : {}),
      ...(scenario.file.endsWith(".pdf") ? { offset: 0, ...(scenario.storage ? { max_chars: 80000 } : { limit: 80000 }) } : {}) } } : undefined, sequence++);
  } });
  const previousUrl = process.env.LEGALWORK_SERVER_URL, previousToken = process.env.LEGALWORK_SERVER_TOKEN;
  process.env.LEGALWORK_SERVER_URL = fixture.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "synthetic-fixture";
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine(async root => {
      directory = join(root, "project");
      const native = await PDFDocument.create(); native.addPage().drawText("Native contract marker");
      native.addPage().drawText("Second page marker"); const bytes = await native.save();
      const scan = await PDFDocument.create(); scan.addPage(); scan.addPage();
      const large = Buffer.concat([bytes, Buffer.alloc(21 * 1024 * 1024, 32)]);
      await writeFile(join(directory, "large.pdf"), large); await writeFile(join(directory, "large-denied.pdf"), large);
      originals.set("large.pdf", large); originals.set("native.pdf", bytes); originals.set("scan.pdf", await scan.save());
      for (const name of ["native.pdf", "denied.pdf"]) await writeFile(join(directory, name), bytes);
      await writeFile(join(directory, "scan.pdf"), await scan.save()); await writeFile(join(directory, "notes.txt"), "First line\nOrdinary file marker\nLast line\n");
      const plugin = join(root, "storage-plugin"), probe = join(root, "probe-plugin"); await mkdir(plugin); await mkdir(probe);
      await buildNativePluginFixture(join(import.meta.dir, "legalwork-storage-tools.ts"), join(plugin, "index.js"));
      const source = join(root, "probe.ts");
      await writeFile(source, `import {Plugin} from '@opencode/plugin'; const observations=[];
export default Plugin.define({id:'pdf-fixture',async setup(ctx){
 await ctx.tool.transform(editor=>{for(const item of editor.list())editor.update(item.id,tool=>{tool.options={...tool.options,codemode:false}})});
 await ctx.tool.hook('execute.after',event=>{if(event.tool==='read'||event.tool==='storage_read_file')observations.push(event)});
 await ctx.rpc.register({id:'pdf-fixture',methods:{observations:{input:{type:'object'},output:{type:'array',items:{type:'object',additionalProperties:true}}}},events:{}},{async observations(){return observations}});
}});`);
      await buildNativePluginFixture(source, join(probe, "index.js"));
      return { plugins: [plugin, probe], model: "fixture/pdf", permissions: [{ action: "*", resource: "*", effect: "allow" }],
        policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: fixture.url.origin + "/v1", apiKey: "synthetic-fixture" }, models: {
          pdf: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] } },
          text: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
        } } } };
    });
    const client = engine.client(); await client.model.list({ location: engine.location });
    for (const current of cases) {
      scenario = current; primaryCalls = 0; primaryWires.length = 0;
      const before = pdfRequests, previousOcr = ocrPages.length;
      const session = await client.session.create({ location: engine.location, agent: "build", model: { providerID: "fixture", id: scenario.pdf ? "pdf" : "text" },
        ...(scenario.deny ? { permissions: [{ action: "read", resource: "*denied.pdf", effect: "deny" }] } : {}) });
      await client.session.prompt({ sessionID: session.id, text: "Read the fixture document." });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
      const history = await client.session.context({ sessionID: session.id });
      const tools = history.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool").filter(part => part.name === (scenario.storage ? "storage_read_file" : "read")) : []);
      expect(tools, JSON.stringify(history)).toHaveLength(1);
      const tool = tools[0]!;
      if (scenario.deny) {
        expect(tool.state.status).toBe("error"); expect(pdfRequests).toBe(before); continue;
      }
      expect(tool.state.status, JSON.stringify(tool.state)).toBe("completed");
      if (tool.state.status !== "completed") throw new Error("PDF read failed");
      expect(JSON.stringify(tool.state), scenario.file).toContain(scenario.expected);
      if (scenario.limit) {
        const text = tool.state.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        expect(text).toContain(`Continue reading with offset: ${scenario.file === "." ? 2 : 3}`);
        if (scenario.file === "notes.txt") {
          expect(text).toContain("2: Ordinary file marker");
          expect(text).not.toContain("First line"); expect(text).not.toContain("Last line");
        }
      }
      const attachments = tool.state.content.filter(part => part.type === "file");
      const attached = scenario.attach === true && !scenario.tooLarge;
      expect(attachments.length, JSON.stringify(scenario)).toBe(attached ? 1 : 0);
      if (attached) {
        const original = originals.get(scenario.file); if (!original) throw new Error("Missing original PDF");
        const actual = Buffer.from(attachments[0]!.uri.slice("data:application/pdf;base64,".length), "base64");
        if (scenario.pages) {
          const parsed = await extractPdfText(new Uint8Array(actual), new AbortController().signal);
          expect(parsed.pageCount).toBe(scenario.pages.length);
          const expected = scenario.pages.includes(2) ? "Second page marker" : "Native contract marker";
          expect(parsed.pages.map(page => page.text).join("\n")).toContain(expected);
          if (!scenario.pages.includes(1)) expect(parsed.pages.map(page => page.text).join("\n")).not.toContain("Native contract marker");
        } else {
          expect(actual.byteLength).toBe(original.byteLength);
          expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
        }
      }
      if (scenario.file.endsWith(".pdf") && !scenario.attach) expect(JSON.stringify(tool.state)).toContain("page_sources");
      if (scenario.attach || !scenario.file.endsWith(".pdf")) { expect(pdfRequests).toBe(before); expect(ocrPages).toHaveLength(previousOcr); }
      if (!scenario.ocr) expect(ocrPages).toHaveLength(previousOcr);
      if (scenario.file === "scan.pdf" && !scenario.ocr) {
        const output = z.object({ pages_without_embedded_text: z.array(z.number()), complete: z.boolean(), ocr_requested: z.boolean() })
          .parse(JSON.parse(tool.state.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")));
        expect(output).toMatchObject({ pages_without_embedded_text: [2], complete: false, ocr_requested: false });
      }
      // Verify what the next model request actually receives, including the absence of implicit PDF bytes.
      expect(primaryWires).toHaveLength(2);
      expect(primaryWires[1]!.includes("JVBERi0"), JSON.stringify(scenario)).toBe(attached);
    }
    expect(ocrPages).toContain(1); expect(ocrPages).toContain(2);
  } finally {
    await engine?.close(); fixture.stop(true);
    if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previousToken;
  }
}, 120000);
