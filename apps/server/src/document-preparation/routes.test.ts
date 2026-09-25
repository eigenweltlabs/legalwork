import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { LegalWorkDocumentTools } from "../opencode-plugins/legalwork-document-tools.js";
import { preparedSchema } from "./service.js";
const statusSchema = z.object({ id: z.string(), engine: z.object({ id: z.string() }), status: z.string(), documents: z.array(z.object({ preparationPath: z.string().optional() })) });

test("agent tools reach workspace-authorized preparation, pin configured API model and survive settings changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "preparation-http-"));
  const previous = { db: process.env.LEGALWORK_RUNTIME_DB, url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]).drawText("First page"); pdf.addPage([200, 200]).drawText("Second page");
  await writeFile(join(workspace, "contract.pdf"), await pdf.save());
  const models: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), first = new Promise<void>(resolve => { entered = resolve; });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = z.object({ model: z.string() }).parse(await request.json()); models.push(body.model);
    if (models.length === 1) { entered(); await gate; }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Recognized contract text" } }] });
  } });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "token", hostToken: "host-token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [],
    workspaces: [{ id: "ws_1", name: "Test", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace], readOnly: false, startedAt: Date.now(),
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const host = { "x-legalwork-host-token": "host-token", "content-type": "application/json" };
    const client = { Authorization: "Bearer token", "content-type": "application/json" };
    const endpoint = `${base}/workspace/ws_1/document-preparations`;
    expect((await fetch(endpoint, { method: "POST", body: "{}" })).status).toBe(401);
    const saved = await fetch(`${base}/ocr/servers`, { headers: host, method: "POST", body: JSON.stringify({ label: "OCR", model: "first-model", endpoint: `http://127.0.0.1:${provider.port}/chat/completions`, languages: null, authentication: "none" }) });
    const engines = z.object({ engines: z.array(z.object({ id: z.string(), kind: z.string() })) }).parse(await saved.json());
    const modelId = engines.engines.find(engine => engine.kind === "chat-completions")!.id;
    expect((await fetch(`${base}/ocr/default`, { headers: host, method: "PUT", body: JSON.stringify({ engineId: modelId }) })).status).toBe(200);
    process.env.LEGALWORK_SERVER_URL = base; process.env.LEGALWORK_SERVER_TOKEN = "token";
    const plugin = await LegalWorkDocumentTools();
    const raw = await plugin.tool.legalwork_document_prepare.execute({ files: ["contract.pdf"] }, { directory: workspace });
    const run = z.object({ ok: z.literal(true), result: statusSchema }).parse(JSON.parse(raw)).result;
    await first;
    expect((await fetch(`${base}/ocr/servers/${modelId}`, { headers: host, method: "PUT", body: JSON.stringify({ label: "OCR", model: "changed-model", endpoint: `http://127.0.0.1:${provider.port}/chat/completions`, languages: null, authentication: "none" }) })).status).toBe(200);
    release();
    let status = run;
    for (let i = 0; i < 300 && ["queued", "running"].includes(status.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = z.object({ ok: z.literal(true), result: statusSchema }).parse(JSON.parse(await plugin.tool.legalwork_document_preparation_status.execute({ id: run.id }, { directory: workspace }))).result;
    }
    expect(status.status).toBe("complete"); expect(models).toEqual(["first-model", "first-model"]);
    const prepared = preparedSchema.parse(JSON.parse(await readFile(join(workspace, status.documents[0]!.preparationPath!), "utf8")));
    expect(prepared.pages.length).toBe(2); expect(prepared.pages[1]!.nativeText).toContain("Second page"); expect(prepared.pages[1]!.ocr?.text).toContain("Recognized");
    expect((await fetch(endpoint, { headers: client, method: "POST", body: JSON.stringify({ files: ["../server.json"] }) })).status).toBe(403);
    config.readOnly = true;
    expect((await fetch(endpoint, { headers: client, method: "POST", body: JSON.stringify({ files: ["contract.pdf"] }) })).status).toBe(403);
    expect((await fetch(`${endpoint}/${run.id}`, { headers: client, method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${endpoint}/${run.id}`, { headers: client })).status).toBe(200);
  } finally {
    release(); provider.stop(true); await server.stop();
    for (const [key, value] of Object.entries({ LEGALWORK_RUNTIME_DB: previous.db, LEGALWORK_SERVER_URL: previous.url, LEGALWORK_SERVER_TOKEN: previous.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
