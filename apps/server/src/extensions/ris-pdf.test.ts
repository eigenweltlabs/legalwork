import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { saveRisSettings, callRisAction } from "./ris.js";

const nativeFetch = globalThis.fetch;
const html = '<html><head><style>p { color: black; }</style></head><body><h2>Gericht</h2><p>Verwaltungsgerichtshof</p><h2>Geschäftszahl</h2><p>Ro 2026/09/0005</p><h2>Text</h2><p>Original § 1, Änderung.</p><table><tr><td>Original table</td></tr></table></body></html>';
const id = "JWT_2026090005_20260610J00";
const args = { id, applikation: "Vwgh", filename: "Decision.pdf" };
const resultSchema = z.object({ result: z.object({ path: z.string(), relativePath: z.string(), filename: z.string(), size: z.number(), generatedFrom: z.string(), ris_citation: z.object({ id: z.string() }) }) });
let root: string, content: string, engine: string, config: ServerConfig;
let requests: string[], rendered: string[];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-ris-pdf-")));
  content = join(root, "documents"); engine = join(root, "engine");
  await mkdir(content); await mkdir(engine);
  requests = []; rendered = [];
  config = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"),
    workspaces: [{ id: "ws", name: "Matter", path: engine, contentPath: content, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [engine], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    renderHtmlPdf: async document => { rendered.push(document.html); return Buffer.from("%PDF-1.7\nrendered source"); },
  };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(html, { headers: { "content-type": "text/html" } });
  }, { preconnect: nativeFetch.preconnect });
  await saveRisSettings(config, { enabled: true });
});
afterEach(async () => { globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }); });

const download = (input: unknown = args) => callRisAction(config, "ris_download_pdf", input, undefined, { directory: engine });

test("renders the unconverted source and saves beside browser downloads in the content folder, preserving existing files", async () => {
  const first = resultSchema.parse(await download()).result;
  const second = resultSchema.parse(await download()).result;
  expect(first).toMatchObject({ path: join(content, "Downloads", "Decision.pdf"), relativePath: "Downloads/Decision.pdf", generatedFrom: "original_ris_html", ris_citation: { id } });
  expect(second.relativePath).toBe("Downloads/Decision (2).pdf");
  expect(await readFile(first.path, "utf8")).toBe("%PDF-1.7\nrendered source");
  expect(rendered).toEqual([html, html]);
  expect(requests.every(url => url === `https://ogd.ris.bka.gv.at/Dokumente/Vwgh/${id}/${id}.html`)).toBe(true);
  expect(await readdir(engine)).toEqual([]);
});

test("rejects unsupported hosts, ambiguous law IDs and destination paths without contacting RIS", async () => {
  for (const input of [{ ...args, id: "https://evil.test/?Dokumentnummer=" + id }, { ...args, id: "10001622" }, { ...args, filename: "../outside.pdf" }, { ...args, filename: "CON.pdf" }])
    await expect(download(input)).rejects.toMatchObject({ code: "ris_validation_error" });
  expect(requests).toHaveLength(0); expect(rendered).toHaveLength(0);
});

test("read-only, missing host renderer and unregistered project contexts cannot download", async () => {
  config.readOnly = true;
  await expect(download()).rejects.toMatchObject({ code: "read_only" });
  config.readOnly = false;
  const render = config.renderHtmlPdf; config.renderHtmlPdf = undefined;
  await expect(download()).rejects.toMatchObject({ code: "ris_pdf_unavailable" });
  config.renderHtmlPdf = render;
  await expect(callRisAction(config, "ris_download_pdf", args)).rejects.toMatchObject({ code: "connector_workspace_required" });
  await expect(callRisAction(config, "ris_download_pdf", args, undefined, { directory: root })).rejects.toMatchObject({ code: "workspace_not_found" });
  expect(requests).toHaveLength(0); expect(rendered).toHaveLength(0);
});

test("a Downloads symlink cannot redirect the generated PDF outside the project", async () => {
  await symlink(engine, join(content, "Downloads"), "dir");
  await expect(download()).rejects.toMatchObject({ code: "ris_pdf_path_invalid" });
  expect(await readdir(engine)).toEqual([]);
});

test("disabling RIS during rendering cancels the download before any file is saved", async () => {
  config.renderHtmlPdf = async (_document, signal) => {
    await saveRisSettings(config, { enabled: false });
    signal.throwIfAborted();
    return Buffer.from("%PDF-1.7\n");
  };
  await expect(download()).rejects.toMatchObject({ code: "ris_cancelled" });
  expect(await readdir(content)).toEqual([]);
});

test("invalid rendered output is not saved as a PDF", async () => {
  config.renderHtmlPdf = async () => Buffer.from("not a PDF");
  await expect(download()).rejects.toMatchObject({ code: "ris_pdf_invalid" });
  expect(await readdir(content)).toEqual([]);
});
