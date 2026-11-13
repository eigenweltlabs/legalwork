import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legalworkBrowserTools } from "./legalwork-browser-tools.js";
import { nativeTool } from "./native-tool.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";
import { z } from "zod";
import { LegalWorkExtensionsPreview } from "./legalwork-extensions-preview.js";
const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-browser-tools-")));
const native = nativePluginTestRuntime(root), calls: Array<{ route: string; body: unknown; session: string | null }> = [];
const token = "b".repeat(64), bytes = Buffer.alloc(6 * 1024 * 1024, 97), png = Buffer.from("complete-image-bytes");
let blockNetwork = false;
let holdCapture = false;
let rejectPasswordFill = false;
let passwordWebsite: string | null = "https://example.com";
const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url), body: unknown = request.method === "POST" ? await request.json() : undefined;
  calls.push({ route: url.pathname, body, session: request.headers.get("x-legalwork-browser-session") });
  if (url.pathname.endsWith("/passwords")) return Response.json({ website: passwordWebsite, passwords: passwordWebsite ? [{ id: "a8b2378c-4bf0-492a-a113-5ef80723e089", label: "Portal", username: "user" }] : [] });
  if (url.pathname.endsWith("/fill-password")) return rejectPasswordFill
    ? Response.json({ ok: false, error: "The current website does not match the saved password's website." }, { status: 400 })
    : Response.json({ filled: true });
  if (url.pathname.endsWith("/upload")) return Response.json({ uploaded: [{ name: "source.bin", bytes: bytes.length }] });
  if (url.pathname.endsWith("/capture")) { if (holdCapture) await Bun.sleep(200); return Response.json({ data: png.toString("base64"), mime: "image/png" }); }
  return Response.json({ downloads: [] });
} });
const previousUrl = process.env.LEGALWORK_SERVER_URL, previousToken = process.env.LEGALWORK_SERVER_TOKEN;
const previousDiscovery = process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
const bridgeCalls: unknown[] = [];
const websiteAdds: Array<{ id: string; url: string; name?: string; loginUrl?: string }> = [];
let rejectWebsiteAdd = false;
let bridgeResult: unknown;
let transferReads = 0;
let downloadContentPath: string | undefined;
const policy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/workspaces") return Response.json({ items: [{ id: "project", path: root, contentPath: downloadContentPath }] });
  if (path.endsWith("/sandbox/session/ses_upload")) return Response.json({ enabled: true, networkMode: blockNetwork ? "block" : "allow" });
  if (path.endsWith("/browser-connections")) {
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    return Response.json({ items: [{ id: "a8b2378c-4bf0-492a-a113-5ef80723e089", label: "Portal", origin: "https://auth.example.com", websites: [{ name: "Portal", url: "https://example.com/research" }], password: "must-not-leak", username: "must-not-leak" }] });
  }
  const websiteAdd = /^\/workspace\/project\/browser-connections\/([^/]+)\/websites$/.exec(path);
  if (websiteAdd && request.method === "POST") {
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    expect(request.headers.get("x-legalwork-host-token")).toBeNull();
    if (rejectWebsiteAdd) return Response.json({ code: "insufficient_scope", message: "Only the connection owner can update saved login websites." }, { status: 403 });
    const body = z.object({ url: z.string(), name: z.string().optional(), loginUrl: z.string().optional() }).strict().parse(await request.json());
    websiteAdds.push({ id: websiteAdd[1]!, ...body });
    return Response.json({ item: { id: websiteAdd[1], label: "Portal", origin: "https://auth.example.com",
      additionalOrigins: body.loginUrl ? [new URL(body.loginUrl).origin] : [], websites: [{ name: body.name ?? "Portal", url: body.url }], password: "must-not-leak", username: "must-not-leak" } });
  }
  if (path === "/execute") { bridgeCalls.push(await request.json()); return Response.json(bridgeResult); }
  if (path.endsWith(`/extensions/${token}/execute/downloads`)) return Response.json({ downloads: [{ id: "file_remote", name: "large-record.bin", state: "completed", path: null, relativePath: null, receivedBytes: bytes.length, totalBytes: bytes.length, error: null, transferRequired: true }] });
  if (path.endsWith(`/extensions/${token}/execute/download`)) { expect(request.headers.get("authorization")).toBe("Bearer fixture"); expect(await request.json()).toEqual({ id: "file_remote" }); transferReads++; return Response.json({ id: "file_remote", name: "large-record.bin", data: bytes.toString("base64") }); }
  return new Response(null, { status: 404 });
} });
process.env.LEGALWORK_SERVER_URL = policy.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture";
afterAll(async () => { broker.stop(true); policy.stop(true); await native.close(); await rm(root, { recursive: true, force: true }); if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previousUrl; if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previousToken; if (previousDiscovery === undefined) delete process.env.LEGALWORK_UI_CONTROL_DISCOVERY; else process.env.LEGALWORK_UI_CONTROL_DISCOVERY = previousDiscovery; });
const browser_url = `${broker.url.origin}/${token}`;
test("registered browser tools expose typed direct results and compose with native tabID without another open", async () => {
  const discovery = join(root, "bridge.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: policy.url.origin, token: "fixture" }));
  process.env.LEGALWORK_UI_CONTROL_DISCOVERY = discovery;
  const runtime = nativePluginTestRuntime(root);
  await runtime.start(LegalWorkExtensionsPreview);
  try {
    const snapshot = { tab: { id: "exact-tab", url: "https://example.com/login", generation: 3 }, content: '@e1 [textbox] "Username"\n@e2 [textbox] "Password"', truncated: false };
    bridgeResult = { ok: true, actionId: "browser.open_url", result: { tab_id: "exact-tab", url: snapshot.tab.url, browser_url, snapshot } };
    const open = runtime.tools.get("legalwork_browser_open_url")!;
    const connect = runtime.tools.get("legalwork_browser_connect")!;
    expect(runtime.tools.has("legalwork_browser_add_website")).toBe(true);
    const opened = (await open.execute({ url: snapshot.tab.url }, nativeTestInvocation("ses_upload"))).output;
    const output = z.object({ tabID: z.string(), browser_url: z.string(), snapshot: z.object({ content: z.string() }) }).parse(opened);
    expect(output).toMatchObject({ tabID: "exact-tab", browser_url, snapshot: { content: snapshot.content } });
    expect(opened).not.toHaveProperty("result");
    const advertised = z.fromJSONSchema(z.record(z.string(), z.unknown()).parse(open.output));
    expect(advertised.safeParse(opened).success).toBe(true);
    expect(advertised.safeParse({ ok: true, result: opened }).success).toBe(false);
    const listed = await runtime.tools.get("legalwork_browser_passwords")!.execute({ browser_url: output.browser_url }, nativeTestInvocation("ses_upload"));
    expect(listed.output).toMatchObject({ passwords: [{ username: "user" }] });
    const passwordTool = runtime.tools.get("legalwork_browser_passwords")!;
    const advertisedPasswords = z.fromJSONSchema(z.record(z.string(), z.unknown()).parse(passwordTool.output));
    expect(advertisedPasswords.safeParse(listed.output).success).toBe(true);
    passwordWebsite = null;
    try {
      const blank = await passwordTool.execute({ browser_url: output.browser_url }, nativeTestInvocation("ses_upload"));
      expect(blank.output).toEqual({ website: null, passwords: [] });
      expect(advertisedPasswords.safeParse(blank.output).success).toBe(true);
    } finally { passwordWebsite = "https://example.com"; }
    for (const input of [{ tabID: output.tabID }, { tab_id: output.tabID }]) {
      expect((await connect.execute(input, nativeTestInvocation("ses_upload"))).output).toEqual(opened);
      expect(bridgeCalls.at(-1)).toMatchObject({ actionId: "browser.connection", args: { tabId: output.tabID }, callerSessionId: "ses_upload" });
    }
    const failure = { ok: false, error: "The local browser engine is unavailable.", code: "engine_unavailable" };
    bridgeResult = failure;
    for (const invoke of [() => open.execute({ url: snapshot.tab.url }, nativeTestInvocation("ses_upload")), () => connect.execute({ tabID: output.tabID }, nativeTestInvocation("ses_upload"))]) {
      await expect(invoke()).rejects.toMatchObject({ message: failure.error, code: failure.code });
    }
  } finally { await runtime.close(); }
});
function tool(name: "legalwork_browser_connections" | "legalwork_browser_add_website" | "legalwork_browser_upload" | "legalwork_browser_capture" | "legalwork_browser_downloads" | "legalwork_browser_passwords" | "legalwork_browser_fill_password", ctx = native.ctx) {
  const definition = legalworkBrowserTools[name];
  return nativeTool(ctx, { name, description: definition.description, schema: "inputSchema" in definition ? definition.inputSchema : z.object(definition.args), execute: (input, context) => definition.execute(input, context) });
}

test("agents add destination URLs directly with a narrow metadata mutation and optional explicit sign-in scope", async () => {
  const permissionCount = native.permissions.length;
  const password_id = "a8b2378c-4bf0-492a-a113-5ef80723e089";
  blockNetwork = true;
  try {
    const result = await tool("legalwork_browser_add_website").execute({ password_id, url: "https://research.example.net/", name: "Library" }, nativeTestInvocation("ses_upload"));
    expect(websiteAdds.at(-1)).toEqual({ id: password_id, url: "https://research.example.net/", name: "Library" });
    expect(result.output).toMatchObject({ item: { id: password_id, additionalOrigins: [], websites: [{ url: "https://research.example.net/" }] } });
    expect(JSON.stringify(result.output)).not.toContain("must-not-leak");
    const expanded = await tool("legalwork_browser_add_website").execute({ password_id, url: "https://research.example.net/", login_url: "https://signin.example.net/login" }, nativeTestInvocation("ses_upload"));
    expect(websiteAdds.at(-1)).toEqual({ id: password_id, url: "https://research.example.net/", loginUrl: "https://signin.example.net/login" });
    expect(expanded.output).toMatchObject({ item: { additionalOrigins: ["https://signin.example.net"] } });
    expect(native.permissions.slice(permissionCount)).toMatchObject([{ action: "legalwork_browser_add_website" }, { action: "legalwork_browser_add_website" }]);
  } finally { blockNetwork = false; }
});

test("direct website additions retain native permission denials, owner errors and strict secure URL validation", async () => {
  const args = { password_id: "a8b2378c-4bf0-492a-a113-5ef80723e089", url: "https://research.example.net/" };
  const before = websiteAdds.length;
  const denied = new Proxy(native.ctx, { get(target, property) {
    if (property === "permission") return { ...target.permission, assert: async () => { throw new Error("Native permission denied"); } };
    return Reflect.get(target, property);
  } });
  await expect(tool("legalwork_browser_add_website", denied).execute(args, nativeTestInvocation("ses_upload"))).rejects.toThrow("Native permission denied");
  expect(websiteAdds).toHaveLength(before);
  native.permissionHandler(async () => {});
  for (const invalid of [{ ...args, url: "http://insecure.example.net" }, { ...args, login_url: "https://user:secret@example.net" }, { ...args, password: "not-accepted" }, { ...args, password_id: "missing" }]) {
    await expect(tool("legalwork_browser_add_website").execute(invalid, nativeTestInvocation("ses_upload"))).rejects.toThrow();
  }
  expect(websiteAdds).toHaveLength(before);
  rejectWebsiteAdd = true;
  try {
    await expect(tool("legalwork_browser_add_website").execute(args, nativeTestInvocation("ses_upload"))).rejects.toThrow("Only the connection owner");
    expect(websiteAdds).toHaveLength(before);
  } finally { rejectWebsiteAdd = false; }
});
test("native password tools send only the ID/ref, preserve calling identity and decline manual-server forwarding", async () => {
  const password_id = "a8b2378c-4bf0-492a-a113-5ef80723e089";
  native.permissionHandler(async () => {});
  expect((await tool("legalwork_browser_passwords").execute({ browser_url }, nativeTestInvocation("ses_upload"))).output).toEqual({ website: "https://example.com", passwords: [{ id: password_id, label: "Portal", username: "user" }] });
  expect((await tool("legalwork_browser_fill_password").execute({ browser_url, password_id, ref: "@e2" }, nativeTestInvocation("ses_upload"))).output).toEqual({ filled: true });
  expect(calls.at(-1)).toEqual({ route: `/${token}/fill-password`, body: { password_id, ref: "@e2" }, session: "ses_upload" });
  rejectPasswordFill = true;
  try {
    await expect(tool("legalwork_browser_fill_password").execute({ browser_url, password_id, ref: "@e2" }, nativeTestInvocation("ses_upload"))).rejects.toThrow("current website does not match");
  } finally { rejectPasswordFill = false; }
  const capability = `${policy.url.origin}/workspace/project/browser/ses_upload/extensions/${token}/execute`;
  await expect(tool("legalwork_browser_fill_password").execute({ browser_url: capability, password_id, ref: "@e2" }, nativeTestInvocation("ses_upload"))).rejects.toThrow("local LegalWork desktop");
});
test("manual-server downloads save complete bytes under native edit permission and repeated reads do not duplicate writes", async () => {
  downloadContentPath = join(root, "connected-documents"); await mkdir(downloadContentPath);
  const asks: unknown[] = []; native.permissionHandler(async input => { asks.push(input); });
  const capability = `${policy.url.origin}/workspace/project/browser/ses_upload/extensions/${token}/execute`;
  const first = await tool("legalwork_browser_downloads").execute({ browser_url: capability }, nativeTestInvocation("ses_upload"));
  const output = z.object({ downloads: z.array(z.object({ path: z.string(), relativePath: z.string(), transferRequired: z.boolean() })) }).parse(first.output);
  expect(output.downloads[0].relativePath).toBe("Downloads/file_remote-large-record.bin"); expect(output.downloads[0].transferRequired).toBe(false);
  expect(await readFile(output.downloads[0].path)).toEqual(bytes);
  expect(asks).toMatchObject([{ permission: "edit", patterns: [join(downloadContentPath, "Downloads/file_remote-large-record.bin")] }]);
  expect(native.permissions).toContainEqual(expect.objectContaining({ action: "legalwork_browser_downloads", resources: ["*"] }));
  expect((await tool("legalwork_browser_downloads").execute({ browser_url: capability }, nativeTestInvocation("ses_upload"))).output).toEqual(first.output); expect(transferReads).toBe(1);
  downloadContentPath = undefined;
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

test("website discovery is typed metadata and remains available without browser network access", async () => {
  native.permissionHandler(async () => {});
  const result = await tool("legalwork_browser_connections").execute({}, nativeTestInvocation("ses_upload"));
  expect(result.output).toEqual({ items: [{ id: "a8b2378c-4bf0-492a-a113-5ef80723e089", label: "Portal", origin: "https://auth.example.com", additionalOrigins: [], websites: [{ name: "Portal", url: "https://example.com/research" }] }] });
  expect(JSON.stringify(result.output)).not.toContain("must-not-leak");
  blockNetwork = true;
  try { expect((await tool("legalwork_browser_connections").execute({}, nativeTestInvocation("ses_upload"))).output).toEqual(result.output); }
  finally { blockNetwork = false; }
});
