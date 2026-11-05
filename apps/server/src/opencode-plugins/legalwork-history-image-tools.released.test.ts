import { expect, test } from "bun:test";
import { createHash, randomFillSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { closeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { ensureWikiAgentToken, revokeWikiAgentSession } from "../wiki/agent-access.js";
import { historyImagePage, historyImagePayload } from "../session-history-image-schema.js";
import { waitForNativeFixture } from "../native-mcp.test-support.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const wireSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).passthrough();
const summary = "## Objective\n- Recover stored synthetic images.\n## Requirements\n- Use exact stored versions.\n## Decisions\n- None.\n## Work State\n### Completed\n- Synthetic images saved in history.\n### Active\n- Verify recovery.\n### Blocked\n- None.\n## Next Move\n1. Discover and read historical images.\n## Relevant Files\n- None.\n## Important Context\n- Stored images remain authoritative.";

/** Valid, compressible pixels are generated in memory, never saved as an image file. */
function png(width: number, height: number, red: number, noise = false) {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(content)); return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  if (noise) { randomFillSync(pixels); for (let y = 0; y < height; y++) pixels[y * (1 + width * 3)] = 0; }
  else for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (1 + width * 3) + 1 + x * 3; pixels[offset] = red; pixels[offset + 1] = x % 251; pixels[offset + 2] = y % 251; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function chatResponse(sequence: number, code?: string, text = "Done") {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `history_image_${sequence}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", ...(code ? { tool_calls: [{ index: 0, id: `call_image_${sequence}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] } : { content: text }) }, null)
    + chunk({}, code ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function imagesInWire(raw: string) {
  const images: Array<{ mime: string; sha256: string; bytes: number }> = [];
  function visit(value: unknown) {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      const comma = value.indexOf(","), mime = value.slice(5, value.indexOf(";")), bytes = Buffer.from(value.slice(comma + 1), "base64");
      images.push({ mime, sha256: hash(bytes), bytes: bytes.length });
    } else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) visit(item);
  }
  visit(JSON.parse(raw)); return images;
}

for (const policy of ["controlled", "default"]) test.skipIf(!binary)(`compiled native history tools recover both stored selectors after real ${policy} compaction without broadening authority`, async () => {
  if (!binary) throw new Error("A verified compiled engine is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-history-image-compiled-")));
  const evidence = process.env.LEGALWORK_TEST_EVIDENCE_DIR ? join(process.env.LEGALWORK_TEST_EVIDENCE_DIR, policy) : undefined;
  if (evidence) await mkdir(evidence, { recursive: true, mode: 0o700 });
  const original = png(2201, 7, 197), capture = png(3, 2, 41);
  const wires: string[] = [], primary: Array<{ scenario: string; raw: string }> = [], transport: unknown[] = [];
  let pixelSourceConsumed = false;
  const rounds = new Map<string, number>();
  const discovery = "let page=await tools.legalwork_history_image_list({});const images=[...page.images];while(page.cursor.next){page=await tools.legalwork_history_image_list({cursor:page.cursor.next});images.push(...page.images);} ";
  const codes: Record<string, string> = {
    capture: "return await tools.fixture_historical_capture({});",
    recover: discovery + "const recovered=[];for(const image of images){recovered.push(await tools.legalwork_history_image_read(image.reference));}return {recovered};",
    denied: discovery + "return await tools.legalwork_history_image_read(images[0].reference);",
  };
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-pixels") {
      if (pixelSourceConsumed) return new Response(null, { status: 404 });
      pixelSourceConsumed = true; return new Response(capture, { headers: { "content-type": "image/png" } });
    }
    const raw = await request.text(); wires.push(raw); const parsed = wireSchema.parse(JSON.parse(raw));
    const lastUser = [...parsed.messages].reverse().find(message => message.role === "user");
    const lastUserText = JSON.stringify(lastUser?.content);
    const compaction = lastUserText.includes("You MUST summarize the conversation above") || lastUserText.includes("previous response did not fill in the required summary template");
    const isPrimary = !compaction && parsed.tools?.some(tool => tool.function.name === "execute") === true;
    const scenario = [...parsed.messages].reverse().filter(message => message.role === "user")
      .map(message => JSON.stringify(message.content).match(/history-image-scenario-\[([a-z]+)\]/)).find(value => value !== null)?.[1] ?? "auxiliary";
    if (isPrimary) primary.push({ scenario, raw });
    const round = rounds.get(scenario) ?? 0;
    if (isPrimary) rounds.set(scenario, round + 1);
    return chatResponse(wires.length, isPrimary && round === 0 ? codes[scenario] : undefined, compaction ? summary : "Done");
  } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let config: ServerConfig | undefined;
  let onNativeRead: (() => void) | undefined;
  const previous = { runtime: process.env.LEGALWORK_RUNTIME_DB, tokens: process.env.LEGALWORK_TOKEN_STORE };
  const snapshots: Record<string, unknown> = {};
  try {
    for (const name of ["home", "config", "data", "cache", "state", "project", "other", "history-plugin", "fixture-plugin"]) await mkdir(join(root, name));
    const directory = join(root, "project"), location = { directory };
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
    config = { host: "127.0.0.1", port: 0, token: "history-fixture-client", hostToken: "history-fixture-host", configPath: join(root, "server.json"),
      workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }, { id: "other", name: "Other", path: join(root, "other"), workspaceType: "local", preset: "starter" }],
      authorizedRoots: [directory, join(root, "other")], readOnly: false, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    server = await startServer(config); const scopedToken = await ensureWikiAgentToken(config);
    const base = `http://127.0.0.1:${server.port}`;
    await buildNativePluginFixture(join(import.meta.dir, "legalwork-history-image-tools.ts"), join(root, "history-plugin", "index.js"));
    const fixtureSource = join(root, "fixture.ts");
    await writeFile(fixtureSource, `import {Plugin} from "@opencode/plugin";const observations=[];let captured=false;export default Plugin.define({id:"history-image-fixture",async setup(ctx){
      const response=await fetch(${JSON.stringify(provider.url.origin + "/fixture-pixels")});if(!response.ok)throw new Error("Synthetic pixel source unavailable");const uri="data:image/png;base64,"+Buffer.from(await response.arrayBuffer()).toString("base64");
      await ctx.tool.transform(editor=>editor.add({name:"fixture_historical_capture",description:"Return an inline-only synthetic screenshot once",input:{type:"object",properties:{}},output:{type:"object",properties:{captured:{type:"boolean"}},required:["captured"]},async execute(){if(captured)throw new Error("The synthetic capture no longer exists");captured=true;return{output:{captured:true},content:[{type:"file",mime:"image/png",uri,name:"inline-capture.png"}]}}}));
      for(const phase of["before","after"])await ctx.tool.hook("execute."+phase,event=>{if(event.tool.startsWith("legalwork_history_image_"))observations.push({phase,...event})});
      await ctx.rpc.register({id:"history-image-fixture",methods:{observations:{input:{type:"object"},output:{type:"array",items:{type:"object",additionalProperties:true}}}},events:{}},{async observations(){return observations}});
    }});`);
    await buildNativePluginFixture(fixtureSource, join(root, "fixture-plugin", "index.js"));
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, timeoutMs: 30000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      LEGALWORK_SERVER_URL: base, LEGALWORK_SERVER_TOKEN: config.token, LEGALWORK_WIKI_AGENT_TOKEN: scopedToken,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, model: "fixture/fixture", plugins: [join(root, "history-plugin"), join(root, "fixture-plugin")],
        ...(policy === "controlled" ? { compaction: { auto: false, keep: { tokens: 0 } } } : {}), permissions: [{ action: "*", resource: "*", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic-local-only" },
          models: { fixture: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } } } } } }),
    } });
    snapshots.fixtureConfig = JSON.parse(engine.execution.env.find(entry => entry.name === "OPENCODE_CONFIG_CONTENT")?.value ?? "null");
    const native = engine;
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url), body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const upstream = await fetch(native.url + url.pathname + url.search, { method: request.method, headers: request.headers, body });
      const bytes = await upstream.bytes(); transport.push({ method: request.method, path: url.pathname, status: upstream.status, body: Buffer.from(bytes).toString() });
      if (request.method === "GET" && /\/api\/session\/[^/]+\/message\/[^/]+$/.test(url.pathname)) onNativeRead?.();
      // fetch has decoded the upstream body; the relay must not retain its old
      // wire length/encoding or attach a body to a no-content response.
      const headers = new Headers(upstream.headers); headers.delete("content-length"); headers.delete("content-encoding");
      return new Response([204, 205, 304].includes(upstream.status) ? null : bytes, { status: upstream.status, headers });
    } });
    config.opencodeBaseUrl = proxy.url.origin; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    const managed = config;
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    await client.model.list({ location });
    snapshots.catalog = await client.plugin.list({ location });
    const clientHeaders = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
    const scopedHeaders = (sessionID: string, path = directory) => ({ "x-legalwork-wiki-agent-token": scopedToken, "x-legalwork-wiki-agent-session": sessionID,
      "x-legalwork-wiki-agent-directory": encodeURIComponent(path), "Content-Type": "application/json" });
    const dispatch = async (sessionID: string, scenario: string, files?: Array<{ uri: string; name: string }>, resume = true, ordinaryText = "") => {
      const response = await fetch(`${base}/workspace/matter/sessions/${sessionID}/dispatch`, { method: "POST", headers: clientHeaders,
        body: JSON.stringify({ kind: "prompt", delivery: "steer", resume, text: `history-image-scenario-[${scenario}]${ordinaryText}`, ...(files ? { files } : {}) }) });
      const text = await response.text(); snapshots[`dispatch-${scenario}`] = { status: response.status, body: text };
      if (!response.ok) throw new Error(`Normal dispatch failed: ${text}`);
      if (resume) await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60000) });
    };
    const session = await client.session.create({ location, title: "Stored inline image acceptance" });
    await dispatch(session.id, "user", [{ uri: `data:image/png;base64,${original.toString("base64")}`, name: "oversized-inline.png" }]);
    await dispatch(session.id, "capture");
    snapshots.captureSources = { sourceSha256: hash(await readFile(fixtureSource)), bundleSha256: hash(await readFile(join(root, "fixture-plugin", "index.js"))), pixelSourceConsumed };
    expect((await readFile(fixtureSource, "utf8"))).not.toContain(capture.toString("base64"));
    expect((await readFile(join(root, "fixture-plugin", "index.js"), "utf8"))).not.toContain(capture.toString("base64"));
    expect((await fetch(provider.url.origin + "/fixture-pixels")).status).toBe(404);
    const before = await client.message.list({ sessionID: session.id, limit: 100 }); snapshots.before = before;
    const user = before.data.find(message => message.type === "user" && message.files?.some(file => file.name === "oversized-inline.png"));
    if (user?.type !== "user" || !user.files?.[0]) throw new Error("The actual stored user image is missing");
    const storedUser = user.files[0], storedUserBytes = Buffer.from(storedUser.data, "base64");
    expect(hash(storedUserBytes)).not.toBe(hash(original));
    const storedTool = before.data.flatMap(message => message.type === "assistant" ? message.content.flatMap(part => part.type === "tool" && part.state.status === "completed"
      ? part.state.content.flatMap(content => content.type === "file" ? [{ messageID: message.id, mime: content.mime, uri: content.uri }] : []) : []) : []).find(file => file.uri.startsWith("data:image/"));
    if (!storedTool) throw new Error("The actual completed-tool image is missing");
    const storedToolBytes = Buffer.from(storedTool.uri.slice(storedTool.uri.indexOf(",") + 1), "base64");
    const expected = [{ mime: storedUser.mime, sha256: hash(storedUserBytes), bytes: storedUserBytes.length }, { mime: storedTool.mime, sha256: hash(storedToolBytes), bytes: storedToolBytes.length }];
    snapshots.identities = { original: { sha256: hash(original), bytes: original.length }, stored: expected };
    snapshots.projectFilesBeforeCompaction = await readdir(directory, { recursive: true });
    expect((await readdir(directory, { recursive: true })).filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name))).toEqual([]);
    if (policy === "default") {
      const ordinaryText = "\n" + Array.from({ length: 1000 }, (_, index) => `Synthetic ordinary note ${index}: the parties discussed the document and its dates.`).join("\n");
      snapshots.defaultTailInput = { bytes: Buffer.byteLength(ordinaryText), sha256: hash(ordinaryText) };
      await dispatch(session.id, "ordinary", undefined, true, ordinaryText);
    }
    await dispatch(session.id, "buffer");
    await client.session.compact({ sessionID: session.id });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
    const context = await client.session.context({ sessionID: session.id }); snapshots.compactedContext = context;
    expect(context.some(message => message.type === "compaction" && message.status === "completed" && message.summary.includes("## Objective"))).toBe(true);
    expect(context.map(message => message.id)).not.toContain(user.id); expect(context.map(message => message.id)).not.toContain(storedTool.messageID);
    snapshots.storedUserAfterCompaction = await client.session.message.get({ sessionID: session.id, messageID: user.id });
    snapshots.storedToolAfterCompaction = await client.session.message.get({ sessionID: session.id, messageID: storedTool.messageID });
    expect(snapshots.storedUserAfterCompaction).toEqual(user);
    expect(snapshots.storedToolAfterCompaction).toEqual(before.data.find(message => message.id === storedTool.messageID));
    await dispatch(session.id, "recover");
    const recoveryWires = primary.filter(item => item.scenario === "recover");
    expect(recoveryWires).toHaveLength(2); expect(imagesInWire(recoveryWires[0]?.raw ?? "{}")).toEqual([]);
    expect(imagesInWire(recoveryWires[1]?.raw ?? "{}").sort((a, b) => a.sha256.localeCompare(b.sha256))).toEqual([...expected].sort((a, b) => a.sha256.localeCompare(b.sha256)));
    const systems = recoveryWires.map(item => wireSchema.parse(JSON.parse(item.raw)).messages.filter(message => message.role === "system"));
    expect(systems[0]?.length).toBeGreaterThan(0); expect(systems[0]).toEqual(systems[1]);
    expect(JSON.stringify(systems)).not.toContain(storedUser.data);
    const after = await client.message.list({ sessionID: session.id, limit: 100 }); snapshots.after = after;
    snapshots.observations = (await client.rpc.call({ location, rpcID: "history-image-fixture", method: "observations", input: {} })).output;
    const observations = z.array(z.object({ phase: z.string(), tool: z.string(), result: z.object({ output: z.unknown() }).optional() }).passthrough()).parse(snapshots.observations);
    expect(observations.filter(event => event.phase === "after" && event.tool === "legalwork_history_image_read")).toHaveLength(2);
    for (const observation of observations) expect(JSON.stringify(observation.result?.output ?? null)).not.toContain("base64");
    const listURL = (id: string, query = "", workspace = "matter") => `${base}/workspace/${workspace}/sessions/${id}/history-images${query}`;
    const page = historyImagePage.parse(await fetch(listURL(session.id), { headers: scopedHeaders(session.id) }).then(response => response.json()));
    const reference = page.images.find(image => image.reference.messageID === user.id)?.reference;
    if (!reference) throw new Error("No native stored image reference");
    const foreign = await client.session.create({ location, title: "Unrelated cursor ownership control" });
    await client.session.prompt({ sessionID: foreign.id, text: "FOREIGN-IMAGE-CURSOR-CONTROL" });
    await client.session.wait({ sessionID: foreign.id }, { signal: AbortSignal.timeout(60000) });
    const foreignPage = await client.message.list({ sessionID: foreign.id, limit: 1, order: "asc" });
    snapshots.foreignPage = foreignPage;
    const foreignMessage = foreignPage.data[0]; if (!foreignMessage || !foreignPage.cursor.next) throw new Error("Foreign cursor fixture missing");
    const ownWithForeignCursor = await client.message.list({ sessionID: session.id, cursor: foreignPage.cursor.next }); snapshots.foreignCursor = ownWithForeignCursor;
    expect(ownWithForeignCursor.data).toEqual([]);
    const foreignGet = await fetch(`${engine.url}/api/session/${session.id}/message/${foreignMessage.id}`, { headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    snapshots.foreignMessage = { status: foreignGet.status, body: await foreignGet.text() }; expect(foreignGet.status).toBe(404);
    const sibling = await fetch(listURL(session.id, `?sessionID=${foreign.id}`), { headers: scopedHeaders(session.id) }); expect(sibling.status).toBe(404);
    const cross = await fetch(listURL(session.id, "", "other"), { headers: scopedHeaders(session.id) }); expect(cross.status).toBe(403);
    const bearer = await fetch(listURL(session.id), { headers: clientHeaders }); expect(bearer.status).toBe(403);
    const child = await client.session.create({ parentID: session.id, title: "Verified native ancestor control" });
    await dispatch(child.id, "child", undefined, false);
    const ancestor = historyImagePayload.parse(await fetch(listURL(child.id, "/read"), { method: "POST", headers: scopedHeaders(child.id), body: JSON.stringify(reference) }).then(response => response.json()));
    expect(ancestor.image.reference).toEqual(reference); expect(hash(Buffer.from(ancestor.uri.slice(ancestor.uri.indexOf(",") + 1), "base64"))).toBe(reference.sha256);
    onNativeRead = () => revokeWikiAgentSession(managed, child.id);
    const revoked = await fetch(listURL(child.id, "/read"), { method: "POST", headers: scopedHeaders(child.id), body: JSON.stringify(reference) });
    snapshots.revoked = { status: revoked.status, body: await revoked.text() }; expect(revoked.status).toBe(403); expect(JSON.stringify(snapshots.revoked)).not.toContain(storedUser.data); onNativeRead = undefined;
    const denied = await client.session.create({ parentID: session.id, title: "Native history image permission refusal", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "legalwork_history_image_read", resource: "*", effect: "ask" }] });
    // The model discovers a real ancestor reference; no hidden identifier is injected into its code.
    codes.denied = "const self=await tools.legalwork_history_image_list({});if(self.parent.status!=='available')throw new Error('No verified parent');let page=await tools.legalwork_history_image_list({sessionID:self.parent.sessionID});while(!page.images.length&&page.cursor.next)page=await tools.legalwork_history_image_list({sessionID:self.parent.sessionID,cursor:page.cursor.next});return await tools.legalwork_history_image_read(page.images[0].reference);";
    const response = await fetch(`${base}/workspace/matter/sessions/${denied.id}/dispatch`, { method: "POST", headers: clientHeaders, body: JSON.stringify({ kind: "prompt", delivery: "steer", text: "history-image-scenario-[denied]" }) });
    expect(response.ok).toBe(true);
    const requests = await waitForNativeFixture(() => client.permission.list({ sessionID: denied.id }), items => items.length > 0, "native stored-image permission");
    const permission = requests[0]; if (!permission) throw new Error("No native permission request");
    snapshots.permission = permission;
    await client.permission.reply({ sessionID: denied.id, requestID: permission.id, decision: "reject", message: "Owned acceptance control denies this history read." });
    await client.session.wait({ sessionID: denied.id }, { signal: AbortSignal.timeout(60000) });
    const deniedWires = primary.filter(item => item.scenario === "denied"); expect(deniedWires).toHaveLength(2); expect(imagesInWire(deniedWires[1]?.raw ?? "{}")).toEqual([]);
    snapshots.deniedHistory = await client.message.list({ sessionID: denied.id });
    snapshots.finalHistory = await client.message.list({ sessionID: session.id, limit: 100 });
    snapshots.finalProjectFiles = await readdir(directory, { recursive: true });
    expect((await readdir(directory, { recursive: true })).filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name))).toEqual([]);
  } finally {
    await engine?.close(); await server?.stop(); proxy?.stop(true); provider.stop(true);
    if (config) closeRuntimeOpencodeConfig(config);
    if (evidence) {
      await writeFile(join(evidence, "complete-provider-requests.json"), JSON.stringify(wires, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "complete-primary-requests.json"), JSON.stringify(primary, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "complete-native-transport.json"), JSON.stringify(transport, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "complete-snapshots.json"), JSON.stringify(snapshots, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "source-identities.json"), JSON.stringify({ binary, binarySha256: hash(await readFile(binary)), testSha256: hash(await readFile(import.meta.path)), userUploadSha256: hash(original), toolImageSha256: hash(capture), aggregateEvictionTested: false, modelSpend: 0 }, null, 2), { mode: 0o600 });
      for (const name of ["engine.db", "engine.db-wal", "engine.db-shm", "runtime.sqlite"]) await cp(join(root, name), join(evidence, name)).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; });
    }
    for (const [key, value] of Object.entries({ LEGALWORK_RUNTIME_DB: previous.runtime, LEGALWORK_TOKEN_STORE: previous.tokens })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

// Deliberately opt-in: this preserves complete >25 MiB history/wires and is
// separate from small compaction coverage, never a production image setting.
test.skipIf(!binary || process.env.LEGALWORK_TEST_HISTORY_IMAGE_AGGREGATE !== "1")("compiled native history image recovery crosses the real aggregate eviction trigger without compaction", async () => {
  if (!binary) throw new Error("A verified compiled engine is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-history-image-aggregate-")));
  const evidence = process.env.LEGALWORK_TEST_EVIDENCE_DIR ? join(process.env.LEGALWORK_TEST_EVIDENCE_DIR, "aggregate") : undefined;
  if (evidence) await mkdir(evidence, { recursive: true, mode: 0o700 });
  const inputs = Array.from({ length: 7 }, (_, index) => ({ name: `aggregate-${index}.png`, bytes: png(1200, 900, index, true) }));
  const files = inputs.map(input => ({ name: input.name, uri: `data:image/png;base64,${input.bytes.toString("base64")}` }));
  const wires: string[] = [], primary: string[] = [], snapshots: Record<string, unknown> = {};
  let recoveryCalls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text(); wires.push(raw); const parsed = wireSchema.parse(JSON.parse(raw));
    const isPrimary = parsed.tools?.some(tool => tool.function.name === "execute") === true;
    if (isPrimary) primary.push(raw);
    const recovery = parsed.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("recover-the-evicted-aggregate-image"));
    const code = isPrimary && recovery && recoveryCalls++ === 0
      ? "let page=await tools.legalwork_history_image_list({});const images=[...page.images];while(page.cursor.next){page=await tools.legalwork_history_image_list({cursor:page.cursor.next});images.push(...page.images);}const selected=images.find(image=>image.name==='aggregate-0.png');if(!selected)throw new Error('Stored image unavailable');return await tools.legalwork_history_image_read(selected.reference);"
      : undefined;
    return chatResponse(wires.length, code);
  } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let config: ServerConfig | undefined;
  const previous = { runtime: process.env.LEGALWORK_RUNTIME_DB, tokens: process.env.LEGALWORK_TOKEN_STORE };
  try {
    for (const name of ["home", "config", "data", "cache", "state", "project", "history-plugin", "observer"]) await mkdir(join(root, name));
    const directory = join(root, "project"), location = { directory };
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
    config = { host: "127.0.0.1", port: 0, token: "aggregate-fixture-client", hostToken: "aggregate-fixture-host", configPath: join(root, "server.json"),
      workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory],
      readOnly: false, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    server = await startServer(config); const scopedToken = await ensureWikiAgentToken(config), base = `http://127.0.0.1:${server.port}`;
    await buildNativePluginFixture(join(import.meta.dir, "legalwork-history-image-tools.ts"), join(root, "history-plugin", "index.js"));
    await writeFile(join(root, "observer", "index.js"), `import {Plugin} from "@opencode/plugin";const observations=[];export default Plugin.define({id:"aggregate-observer",async setup(ctx){for(const phase of["before","after"])await ctx.tool.hook("execute."+phase,event=>{if(event.tool.startsWith("legalwork_history_image_"))observations.push({phase,...event})});await ctx.rpc.register({id:"aggregate-observer",methods:{observations:{input:{type:"object"},output:{type:"array",items:{type:"object",additionalProperties:true}}}},events:{}},{async observations(){return observations}})}});`);
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, timeoutMs: 30000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      LEGALWORK_SERVER_URL: base, LEGALWORK_SERVER_TOKEN: config.token, LEGALWORK_WIKI_AGENT_TOKEN: scopedToken,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, model: "fixture/fixture", plugins: [join(root, "history-plugin"), join(root, "observer")],
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic-local-only" },
          models: { fixture: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } } } } } }),
    } });
    snapshots.fixtureConfig = JSON.parse(engine.execution.env.find(entry => entry.name === "OPENCODE_CONFIG_CONTENT")?.value ?? "null");
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    await client.model.list({ location });
    const session = await client.session.create({ location, title: "Actual aggregate image eviction and recovery" });
    const dispatch = async (text: string, imageFiles?: typeof files) => {
      const response = await fetch(`${base}/workspace/matter/sessions/${session.id}/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${config?.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "prompt", delivery: "steer", text, ...(imageFiles ? { files: imageFiles } : {}) }) });
      const body = await response.text(); snapshots[`dispatch-${text}`] = { status: response.status, body };
      if (!response.ok) throw new Error(`Normal aggregate dispatch failed: ${body}`);
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(90000) });
    };
    expect(files.every(file => Buffer.byteLength(file.uri.slice(file.uri.indexOf(",") + 1)) < 5 * 1024 * 1024)).toBe(true);
    expect(files.reduce((sum, file) => sum + Buffer.byteLength(file.uri), 0)).toBeGreaterThan(25 * 1024 * 1024);
    await dispatch("Seven inline-only synthetic images are supplied for aggregate visibility acceptance.", files);
    const before = await client.message.list({ sessionID: session.id });
    const user = before.data.find(message => message.type === "user" && message.files?.length === 7);
    if (user?.type !== "user" || !user.files?.[0]) throw new Error("Complete native aggregate images were not stored");
    const stored = user.files.map(file => ({ name: file.name, mime: file.mime, sha256: hash(Buffer.from(file.data, "base64")), encodedBytes: Buffer.byteLength(file.data) }));
    snapshots.storedImageIdentities = stored;
    expect(stored.every((image, index) => image.sha256 === hash(inputs[index]?.bytes ?? Buffer.alloc(0)))).toBe(true);
    expect(stored.every(image => image.encodedBytes < 5 * 1024 * 1024)).toBe(true);
    expect(stored.reduce((sum, image) => sum + image.encodedBytes, 0)).toBeGreaterThan(25 * 1024 * 1024);
    expect(primary).toHaveLength(1);
    const initial = imagesInWire(primary[0] ?? "{}"); snapshots.initialVisibleImages = initial;
    expect(initial.some(image => image.sha256 === stored[0]?.sha256)).toBe(false);
    expect(initial.length).toBeGreaterThan(0); expect(initial.length).toBeLessThan(7);
    expect(primary[0]).toContain("removed");
    expect((await readdir(directory, { recursive: true })).filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name))).toEqual([]);
    await dispatch("recover-the-evicted-aggregate-image using its stored history reference.");
    expect(primary).toHaveLength(3);
    const recoveredWire = imagesInWire(primary[2] ?? "{}"); snapshots.finalVisibleImages = recoveredWire;
    const originalStored = stored[0]; if (!originalStored) throw new Error("No selected historical identity");
    expect(recoveredWire.filter(image => image.sha256 === originalStored.sha256)).toEqual([{ mime: originalStored.mime, sha256: originalStored.sha256, bytes: inputs[0]?.bytes.length }]);
    const systems = primary.slice(1).map(raw => wireSchema.parse(JSON.parse(raw)).messages.filter(message => message.role === "system"));
    expect(systems[0]).toEqual(systems[1]);
    snapshots.observations = (await client.rpc.call({ location, rpcID: "aggregate-observer", method: "observations", input: {} })).output;
    const observations = z.array(z.object({ phase: z.string(), tool: z.string(), result: z.object({ output: z.unknown() }).optional() }).passthrough()).parse(snapshots.observations);
    expect(observations.filter(event => event.phase === "after" && event.tool === "legalwork_history_image_read")).toHaveLength(1);
    for (const event of observations) expect(JSON.stringify(event.result?.output ?? null)).not.toContain("base64");
    snapshots.completeHistory = await client.message.list({ sessionID: session.id });
    expect((await client.session.context({ sessionID: session.id })).some(message => message.type === "compaction")).toBe(false);
    snapshots.projectFiles = await readdir(directory, { recursive: true });
  } finally {
    await engine?.close(); await server?.stop(); provider.stop(true); if (config) closeRuntimeOpencodeConfig(config);
    if (evidence) {
      for (const input of inputs) await writeFile(join(evidence, input.name), input.bytes, { mode: 0o600 });
      await writeFile(join(evidence, "complete-provider-requests.json"), JSON.stringify(wires, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "complete-snapshots.json"), JSON.stringify(snapshots, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "source-identities.json"), JSON.stringify({ binary, binarySha256: hash(await readFile(binary)), testSha256: hash(await readFile(import.meta.path)), aggregateEvictionTested: true, modelSpend: 0 }, null, 2), { mode: 0o600 });
      for (const name of ["engine.db", "engine.db-wal", "engine.db-shm", "runtime.sqlite"]) await cp(join(root, name), join(evidence, name)).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; });
    }
    for (const [key, value] of Object.entries({ LEGALWORK_RUNTIME_DB: previous.runtime, LEGALWORK_TOKEN_STORE: previous.tokens })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
