import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legalworkBrowserTools } from "./legalwork-browser-tools.js";
import { nativeTool } from "./native-tool.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";
import { z } from "zod";
const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-browser-tools-")));
const native = nativePluginTestRuntime(root), calls: Array<{ route: string; body: unknown; session: string | null }> = [];
const token = "b".repeat(64), bytes = Buffer.alloc(6 * 1024 * 1024, 97), png = Buffer.from("complete-image-bytes");
let holdCapture = false;
const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url), body: unknown = request.method === "POST" ? await request.json() : undefined;
  calls.push({ route: url.pathname, body, session: request.headers.get("x-legalwork-browser-session") });
  if (url.pathname.endsWith("/upload")) return Response.json({ uploaded: [{ name: "source.bin", bytes: bytes.length }] });
  if (url.pathname.endsWith("/capture")) { if (holdCapture) await Bun.sleep(200); return Response.json({ data: png.toString("base64"), mime: "image/png" }); }
  return Response.json({ downloads: [] });
} });
const previousUrl = process.env.LEGALWORK_SERVER_URL, previousToken = process.env.LEGALWORK_SERVER_TOKEN;
let transferReads = 0;
const policy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/workspaces") return Response.json({ items: [{ id: "project", path: root }] });
  if (path.endsWith("/sandbox/session/ses_upload")) return Response.json({ enabled: true, networkMode: "allow" });
  if (path.endsWith(`/extensions/${token}/execute/downloads`)) return Response.json({ downloads: [{ id: "file_remote", name: "large-record.bin", state: "completed", path: null, relativePath: null, receivedBytes: bytes.length, totalBytes: bytes.length, error: null, transferRequired: true }] });
  if (path.endsWith(`/extensions/${token}/execute/download`)) { expect(request.headers.get("authorization")).toBe("Bearer fixture"); expect(await request.json()).toEqual({ id: "file_remote" }); transferReads++; return Response.json({ id: "file_remote", name: "large-record.bin", data: bytes.toString("base64") }); }
  return new Response(null, { status: 404 });
} });
process.env.LEGALWORK_SERVER_URL = policy.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture";
afterAll(async () => { broker.stop(true); policy.stop(true); await native.close(); await rm(root, { recursive: true, force: true }); if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previousUrl; if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previousToken; });
const browser_url = `${broker.url.origin}/${token}`;
function tool(name: "legalwork_browser_upload" | "legalwork_browser_capture" | "legalwork_browser_downloads") {
  const definition = legalworkBrowserTools[name];
  return nativeTool(native.ctx, { name, description: definition.description, schema: z.object(definition.args), execute: (input, context) => definition.execute(input, context) });
}
test("manual-server downloads save complete bytes under native edit permission and repeated reads do not duplicate writes", async () => {
  const asks: unknown[] = []; native.permissionHandler(async input => { asks.push(input); });
  const capability = `${policy.url.origin}/workspace/project/browser/ses_upload/extensions/${token}/execute`;
  const first = await tool("legalwork_browser_downloads").execute({ browser_url: capability }, nativeTestInvocation("ses_upload"));
  const output = z.object({ downloads: z.array(z.object({ path: z.string(), relativePath: z.string(), transferRequired: z.boolean() })) }).parse(first.output);
  expect(output.downloads[0].relativePath).toBe("Downloads/file_remote-large-record.bin"); expect(output.downloads[0].transferRequired).toBe(false);
  expect(await readFile(output.downloads[0].path)).toEqual(bytes);
  expect(asks).toMatchObject([{ permission: "edit", patterns: [join(root, "Downloads/file_remote-large-record.bin")] }]);
  expect(native.permissions).toContainEqual(expect.objectContaining({ action: "legalwork_browser_downloads", resources: ["*"] }));
  expect((await tool("legalwork_browser_downloads").execute({ browser_url: capability }, nativeTestInvocation("ses_upload"))).output).toEqual(first.output); expect(transferReads).toBe(1);
});
test("large uploads preserve full bytes and filenames, bind the chat, and require exact source-read permission", async () => {
  await writeFile(join(root, "source.bin"), bytes);
  const asks: unknown[] = []; native.permissionHandler(async input => { asks.push(input); });
  const result = await tool("legalwork_browser_upload").execute({ browser_url, selector: "#upload", paths: ["source.bin"] }, nativeTestInvocation("ses_upload"));
  expect(result.output).toEqual({ uploaded: [{ name: "source.bin", bytes: bytes.length }] });
  const sent = z.object({ files: z.array(z.object({ name: z.string(), data: z.string() })) }).parse(calls.at(-1)?.body);
  expect(Buffer.from(sent.files[0].data, "base64")).toEqual(bytes); expect(sent.files[0].name).toBe("source.bin");
  expect(calls.at(-1)?.session).toBe("ses_upload"); expect(asks).toEqual([{ permission: "read", patterns: [join(root, "source.bin")], always: [join(root, "source.bin")], metadata: { browserUpload: true } }]);
  const before = calls.length; native.permissionHandler(async () => { throw new Error("Read denied"); });
  await expect(tool("legalwork_browser_upload").execute({ browser_url, selector: "#upload", paths: ["source.bin"] }, nativeTestInvocation("ses_upload"))).rejects.toThrow("Read denied"); expect(calls).toHaveLength(before);
});
test("background captures preserve complete image bytes in the project and cannot write through a foreign symlink", async () => {
  const asks: unknown[] = []; native.permissionHandler(async input => { asks.push(input); });
  const result = await tool("legalwork_browser_capture").execute({ browser_url, output_path: "reports/capture.png" }, nativeTestInvocation("ses_upload"));
  expect(result.output).toEqual({ path: "reports/capture.png", mime: "image/png", bytes: png.length });
  expect(await readFile(join(root, "reports/capture.png"))).toEqual(png); expect(asks).toMatchObject([{ permission: "edit", patterns: [join(root, "reports/capture.png")] }]);
  const outside = await mkdtemp(join(tmpdir(), "browser-foreign-"));
  try { await symlink(outside, join(root, "outside")); await expect(tool("legalwork_browser_capture").execute({ browser_url, output_path: "outside/capture.png" }, nativeTestInvocation("ses_upload"))).rejects.toThrow("inside the calling project"); }
  finally { await rm(outside, { recursive: true, force: true }); }
});
test("a cancelled capture cannot write or replay the image after a delayed desktop response", async () => {
  holdCapture = true; native.permissionHandler(async () => {}); const controller = new AbortController();
  const pending = tool("legalwork_browser_capture").execute({ browser_url, output_path: "cancelled.png" }, nativeTestInvocation("ses_upload", controller.signal));
  setTimeout(() => controller.abort(new Error("User stopped capture")), 30);
  await expect(pending).rejects.toThrow(); await Bun.sleep(220);
  expect(await readFile(join(root, "cancelled.png")).catch(() => null)).toBeNull(); holdCapture = false;
});
