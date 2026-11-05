import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { OpenCode, type JsonValue } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { legalMemoryRpc, legalMemoryResponseSchema } from "./legalmemory-rpc.js";
import { fetchLegalMemoryDocument, fetchLegalMemoryGraph, fetchLegalMemoryTreeRoots, type LegalMemoryClient } from "./legalmemory-fetch.js";
import { migrateLegacyMcpCredentials } from "./legacy-mcp-credentials.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
// These watchdogs fail a broken test infrastructure; they are not application,
// tool-output, session, or model limits. No inference endpoint is permitted.
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  do { const value = await read(); if (accept(value)) return value; await Bun.sleep(20); } while (Date.now() < deadline);
  throw new Error("Released LegalMemory fixture did not become ready within its 15s test watchdog.");
}

test.skipIf(!binary).each(["native", "v1 import"])("released LegalMemory preserves full bytes, OAuth rotation, permissions, isolation and cancellation with %s credentials", async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-legalmemory-")));
  for (const name of ["home", "config", "data", "cache", "state", "project", "other", "plugin", "probe"]) await mkdir(join(root, name));
  let validUntil = Infinity;
  let modelCalls = 0, refreshes = 0, initializations = 0, treeCalls = 0, toolCalls = 0, deleteCalls = 0;
  let redirectTree = false, redirectHits = 0;
  const redirectTarget = Bun.serve({ port: 0, fetch() { redirectHits++; return Response.json({ roots: [] }); } });
  let acceptedAccess = "fixture-initial", acceptedRefresh = "fixture-refresh-initial", treeDenied = false, denyPermission = false;
  let nativeRelease: (() => void) | undefined;
  let nativeRequestID: number | string | undefined;
  let completedDownloadStreams = 0;
  let downloadStarted = false, cancelDownloads = false, nativeStarted = false, cancelNative = false, nativeCancelled = false;
  const fullText = "Complete LegalMemory result ".repeat(12_000);
  const original = Buffer.from(`ORIGINAL DOCX\u0000${fullText}`);
  const roots = [{ source_id: "source", display_name: "Firm documents", kind: "fixture", project_id: null, status: "ready", files: 1 }];
  const provider = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url), base = url.origin;
    if (url.pathname.startsWith("/v1")) { modelCalls++; return new Response("Inference forbidden in this protocol fixture", { status: 403 }); }
    if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/authorize") {
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      return Response.redirect(callback.href);
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        if (body.get("refresh_token") !== acceptedRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
        // Hold one token request briefly so concurrent native tool reads overlap.
        await Bun.sleep(50);
        acceptedAccess = `fixture-rotated-${refreshes}`; acceptedRefresh = `fixture-refresh-${refreshes}`;
      }
      validUntil = Date.now() + (body.get("grant_type") === "refresh_token" ? 3_600_000 : 5000);
      return Response.json({ access_token: acceptedAccess, refresh_token: acceptedRefresh, expires_in: body.get("grant_type") === "refresh_token" ? 3600 : 5, token_type: "Bearer" });
    }
    if (request.headers.get("authorization") !== `Bearer ${acceptedAccess}` || Date.now() >= validUntil) return new Response("Authentication required", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
    if (url.pathname === "/api/tree" || url.pathname.startsWith("/api/tree/")) {
      treeCalls++;
      if (redirectTree) return Response.redirect(redirectTarget.url.href);
      if (treeDenied) { treeDenied = false; return new Response("Expired access", { status: 401 }); }
      return Response.json({ roots });
    }
    if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") { deleteCalls++; return new Response(null, { status: 204 }); }
    const body = await request.json();
    if (body.id === undefined) { if (body.method === "notifications/cancelled" && body.params.requestId === nativeRequestID) { nativeCancelled = true; nativeRelease?.(); } return new Response(null, { status: 202 }); }
    let result: unknown;
    if (body.method === "initialize") { initializations++; result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "LegalMemory fixture", version: "1" } }; }
    else if (body.method === "tools/list") result = { tools: ["list_connectors", "list_matters", "list_matter_documents", "search_semantic", "download_document", "find_related_documents"].map(name => ({ name, description: "Read-only synthetic fixture operation", inputSchema: { type: "object", additionalProperties: true } })) };
    else if (body.method === "tools/call") {
      toolCalls++;
      if (body.params.name === "download_document") {
        downloadStarted = true;
        if (cancelDownloads) await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        result = { content: [{ type: "resource", resource: { uri: "legalmemory://document/original", name: "Original.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", blob: original.toString("base64") } }] };
      } else if (body.params.name === "list_connectors" && cancelNative) { nativeStarted = true; nativeRequestID = body.id; await new Promise<void>(resolve => { nativeRelease = resolve; request.signal.addEventListener("abort", () => { nativeCancelled = true; resolve(); }, { once: true }); }); result = { content: [{ type: "text", text: "cancelled" }] };
      } else if (body.params.name === "find_related_documents") result = { content: [{ type: "text", text: JSON.stringify({ root_document: { document_id: "original" }, detail: fullText }) }], structuredContent: { root_document: { document_id: "original" }, detail: "Less-complete secondary graph" } };
      else result = { content: [{ type: "text", text: JSON.stringify({ results: [], fullText }) }] };
    }
    if (body.method === "tools/call" && body.params.name === "download_document" && !cancelDownloads) {
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
      const frame = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(frame.slice(0, 97)); controller.enqueue(frame.slice(97)); /* Remain open, as MCP SSE permits. */ }, cancel() { completedDownloadStreams++; } }), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: body.method === "initialize" ? { "mcp-session-id": `fixture-${initializations}` } : {} });
  } });
  const settingsPath = join(root, "settings.json"), directory = join(root, "project"), other = join(root, "other");
  const serverUrl = `${provider.url.origin}/mcp`;
  await writeFile(settingsPath, JSON.stringify({ version: 2, sharedConfiguration: {}, workspaces: { project: { directory, configuration: {}, providerActivation: {}, projectPermissionApprovals: [] } } }), { mode: 0o600 });
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-legalmemory.ts", import.meta.url))], outdir: join(root, "plugin"), naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
  if (!build.success) throw new AggregateError(build.logs, "LegalMemory fixture must build");
  // Separate fixture RPC invokes the real native registered MCP tool path with
  // a real session. It also supplies a firm-like native permission hook denial.
  await writeFile(join(root, "probe", "index.js"), `import {Plugin} from '@opencode/plugin';export default Plugin.define({id:'legalwork.legalmemory-fixture',async setup(ctx){let deny='allow';await ctx.permission.hook('evaluate',event=>{if(deny!=='allow'&&event.action.startsWith('legalmemory_')){event.effect=deny;event.message='Fixture firm denial';}});await ctx.rpc.register({id:'legalwork.legalmemory-fixture',methods:{catalog:{input:{type:'object'},output:{type:'array',items:{type:'string'}}},deny:{input:{type:'object'},output:{type:'boolean'}},tool:{input:{type:'object'},output:{type:'object'}}},events:{}},{catalog:async()=> (await ctx.tool.list()).map(t=>t.id),deny:async input=>{deny=input.value===true?'deny':input.value==='ask'?'ask':'allow';return deny!=='allow'},tool:async input=>{const session=await ctx.session.get({sessionID:input.sessionID});const message=await ctx.session.synthetic({sessionID:session.id,text:'Fixture native tool read',resume:false});const tool=(await ctx.tool.list()).find(t=>t.id==='legalmemory_list_connectors');return tool.execute({},{sessionID:session.id,agent:'build',messageID:message.id,id:'call_fixture',signal:new AbortController().signal,progress:async()=>{}})}})}});`);
  let application: Awaited<ReturnType<typeof startServer>> | undefined;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    const engineOptions = { bin: binary, cwd: directory, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: join(root, "config"), LEGALMEMORY_FIXTURE_URL: serverUrl, OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [join(root, "probe"), { package: join(root, "plugin"), options: { settingsPath } }], mcp: { servers: { legalmemory: { type: "remote", url: "{env:LEGALMEMORY_FIXTURE_URL}", oauth: { client_id: "fixture-client" } } } }, policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }], providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "fixture" }, models: { fixture: { capabilities: { tools: true } } } } } }),
    } };
    engine = await createManagedOpencodeServer(engineOptions);
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } }), location = { directory };
    await client.model.list({ location });
    const nativeServer = await eventually(async () => (await client.mcp.list({ location })).data.find(server => server.name === "legalmemory"), server => Boolean(server?.integrationID));
    if (!nativeServer?.integrationID) throw new Error("Native OAuth integration unavailable");
    const integrationID = nativeServer.integrationID;
    const integration = await client.integration.get({ integrationID, location });
    const method = integration.data.methods.find(method => method.type === "oauth");
    if (!method || method.type !== "oauth") throw new Error("Native OAuth method unavailable");
    if (mode === "v1 import") {
      validUntil = Date.now() + 5000;
      const source = join(root, "mcp-auth.json");
      await writeFile(source, JSON.stringify({ legalmemory: { serverUrl, tokens: { accessToken: acceptedAccess, refreshToken: acceptedRefresh, expiresAt: validUntil / 1000 }, clientInfo: { clientId: "fixture-client" } } }));
      expect(await migrateLegacyMcpCredentials(client, source, join(root, "receipts", "mcp.json"))).toEqual({ imported: 1, retained: 0 });
    } else {
      const authorization = await client.integration.oauth.connect({ integrationID, methodID: method.id, location });
      await fetch(authorization.data.url);
      await eventually(async () => (await client.integration.oauth.status({ integrationID, attemptID: authorization.data.attemptID, location })).data, status => status.status === "complete");
    }
    await eventually(async () => (await client.mcp.list({ location })).data.find(server => server.name === "legalmemory")?.status.status, status => status === "connected");
    await eventually(async () => (await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "catalog", location, input: {} })).output, value => Array.isArray(value) && value.includes("legalmemory_find_related_documents"));
    const request = async (operation: JsonValue, signal?: AbortSignal, target = location) => legalMemoryResponseSchema.parse((await client.rpc.call({ rpcID: legalMemoryRpc.id, method: "request", location: target, input: { serverName: "legalmemory", operation } }, { signal })).output);
    const transport: LegalMemoryClient = { tree: async (name, params) => { const result = await request({ type: "tree", name, params: JSON.parse(JSON.stringify(params)) }); if (!result.ok) throw new Error(result.code); return result.value; }, callTool: async (name, args) => { const result = await request({ type: "tool", name, args: JSON.parse(JSON.stringify(args)) }); if (!result.ok) throw new Error(result.code); return result.value; } };
    expect(await client.rpc(legalMemoryRpc).servers({}, { location })).toEqual({ names: ["legalmemory"] });
    expect(await fetchLegalMemoryTreeRoots(transport)).toEqual({ roots });
    redirectTree = true;
    expect(await request({ type: "tree", name: "roots", params: {} })).toMatchObject({ ok: false });
    expect(redirectHits).toBe(0); redirectTree = false;
    const document = await fetchLegalMemoryDocument(transport, "original");
    expect(document.filename).toBe("Original.docx"); expect(document.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document"); expect(Buffer.from(document.bytes).equals(original)).toBe(true);
    expect(await fetchLegalMemoryGraph(transport, "original")).toEqual({ root_document: { document_id: "original" }, detail: fullText });
    expect(deleteCalls).toBe(1); expect(completedDownloadStreams).toBe(1);
    // Let the short-lived fixture token expire naturally. Public API only; no SQLite/auth-file access.
    const credential = (await client.credential.list()).find(entry => entry.integrationID === integrationID);
    if (!credential || credential.value.type !== "oauth") throw new Error("Native OAuth credential unavailable");
    expect(refreshes).toBe(0);
    await Bun.sleep(Math.max(0, credential.value.expires - Date.now()) + 20);
    const live = await client.session.create({ location, agent: "build", model: { providerID: "fixture", id: "fixture" }, permissions: [{ action: "legalmemory_list_connectors", resource: "*", effect: "allow" }] });
    const initializeBefore = initializations;
    const [tree, nativeRead] = await Promise.all([request({ type: "tree", name: "roots", params: {} }), client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "tool", location, input: { sessionID: live.id } })]);
    expect(tree.ok).toBe(true); expect(JSON.stringify(nativeRead.output)).toContain(fullText); expect(refreshes).toBe(1); expect(initializations).toBe(initializeBefore);
    const rotated = (await client.credential.list()).find(entry => entry.id === credential.id);
    expect(rotated?.value.type === "oauth" && rotated.value.refresh === acceptedRefresh).toBe(true);
    treeDenied = true;
    expect((await request({ type: "tree", name: "roots", params: {} })).ok).toBe(true);
    expect(refreshes).toBe(1); // A transient tree401 neither rotates nor invalidates a valid native token.
    expect((await client.credential.list()).some(entry => entry.id === credential.id)).toBe(true);
    await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "deny", location, input: { value: true } }); denyPermission = true;
    const beforeDenied = treeCalls + toolCalls;
    expect(await request({ type: "tree", name: "roots", params: {} })).toMatchObject({ ok: false, code: "permission_denied" });
    expect(await request({ type: "tool", name: "download_document", args: { document_id: "original", inline_blob: true } })).toMatchObject({ ok: false, code: "permission_denied" });
    expect(await request({ type: "tool", name: "find_related_documents", args: { document_id: "original" } })).toMatchObject({ ok: false, code: "permission_denied" });
    expect(treeCalls + toolCalls).toBe(beforeDenied);
    await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "deny", location, input: { value: false } }); denyPermission = false;
    await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "deny", location, input: { value: "ask" } });
    const askController = new AbortController();
    const asking = request({ type: "tree", name: "roots", params: {} }, askController.signal);
    const waiting = await eventually(async () => {
      const sessions = (await client.session.list({ directory })).data.filter(session => session.metadata?.legalworkInternal === "legalmemory");
      for (const session of sessions) { const permissions = await client.permission.list({ sessionID: session.id }); if (permissions.length) return { session, permissions }; }
    }, value => Boolean(value));
    expect(waiting?.permissions[0]?.source?.type).toBe("tool");
    const beforeCancelledPermission = treeCalls + toolCalls;
    askController.abort(); await expect(asking).rejects.toBeDefined();
    await eventually(async () => (await client.session.list({ directory })).data.filter(session => session.metadata?.legalworkInternal === "legalmemory"), sessions => sessions.length === 0);
    expect(treeCalls + toolCalls).toBe(beforeCancelledPermission);
    await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "deny", location, input: { value: false } });
    const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture-lw-collaborator", hostToken: "fixture-lw-host", configPath: join(root, "server", "config.json"),
      opencodeBaseUrl: engine.url, opencodeUsername: engine.username, opencodePassword: engine.password,
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [{ id: "project", name: "LegalMemory fixture project", path: directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [root],
      readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    application = await startServer(config);
    const uiRequest = (suffix: string, body?: unknown, token = config.token) => fetch(`http://127.0.0.1:${application?.port}/workspace/project/legalmemory/${suffix}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "deny", location, input: { value: "ask" } });
    const uiGraph = uiRequest("graph", { document_id: "original" });
    const safePending = await eventually(async () => (await uiRequest("permissions")).json(), value => value.requests?.length > 0);
    expect(safePending.workspace.name).toBe("LegalMemory fixture project");
    expect(safePending.requests[0].action).toBe("legalmemory_find_related_documents");
    expect(JSON.stringify(safePending)).not.toContain("sessionID"); expect(JSON.stringify(safePending)).not.toContain(acceptedAccess);
    const approval = { operationID: safePending.requests[0].operationID, requestID: safePending.requests[0].requestID, decision: "once" };
    expect((await uiRequest("permissions", undefined, "owt_retired_viewer")).status).toBe(401);
    expect((await uiRequest("permissions", approval, "owt_retired_viewer")).status).toBe(401);
    expect((await uiRequest("permissions", { ...approval, operationID: "not-this-operation" })).status).toBe(409);
    expect((await uiRequest("permissions", approval)).status).toBe(200);
    const graphResponse = await uiGraph;
    expect(graphResponse.status).toBe(200); expect((await graphResponse.json()).graph.detail.length).toBe(fullText.length);
    expect((await uiRequest("permissions", approval)).status).toBe(409);
    expect((await (await uiRequest("permissions")).json()).requests).toEqual([]);
    const deniedRead = uiRequest("graph", { document_id: "original" });
    const denyPending = await eventually(async () => (await uiRequest("permissions")).json(), value => value.requests?.length > 0);
    expect((await uiRequest("permissions", { operationID: denyPending.requests[0].operationID, requestID: denyPending.requests[0].requestID, decision: "reject" })).status).toBe(200);
    expect((await deniedRead).status).toBe(403);
    await client.rpc.call({ rpcID: "legalwork.legalmemory-fixture", method: "deny", location, input: { value: false } });
    await client.model.list({ location: { directory: other } });
    expect(await request({ type: "tree", name: "roots", params: {} }, undefined, { directory: other })).toMatchObject({ ok: false });
    downloadStarted = false; cancelDownloads = true;
    const controller = new AbortController();
    const pending = request({ type: "tool", name: "download_document", args: { document_id: "original", inline_blob: true } }, controller.signal);
    await eventually(async () => downloadStarted, Boolean); controller.abort();
    await expect(pending).rejects.toBeDefined();
    await eventually(async () => (await client.session.list({ directory })).data.filter(session => session.metadata?.legalworkInternal === "legalmemory"), sessions => sessions.length === 0);
    cancelNative = true;
    const nativeController = new AbortController();
    const nativePending = request({ type: "tool", name: "list_connectors", args: {} }, nativeController.signal);
    await eventually(async () => nativeStarted, Boolean); nativeController.abort();
    await expect(nativePending).rejects.toBeDefined();
    await eventually(async () => nativeCancelled, Boolean);
    await eventually(async () => (await client.session.list({ directory })).data.filter(session => session.metadata?.legalworkInternal === "legalmemory"), sessions => sessions.length === 0);
    cancelNative = false;
    expect((await client.message.list({ sessionID: live.id })).data).toHaveLength(0); // Synthetic source remains nonresuming; no visible conversation turns.
    expect(await client.session.active()).toEqual({}); expect(modelCalls).toBe(0); expect(denyPermission).toBe(false);
    expect(JSON.stringify(await request({ type: "tree", name: "roots", params: {} }))).not.toContain(acceptedAccess);
    await client.session.remove({ sessionID: live.id });
    const orphan = await client.session.create({ location, agent: "build", model: { providerID: "fixture", id: "fixture" }, metadata: { legalworkInternal: "legalmemory" }, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    await client.session.synthetic({ sessionID: orphan.id, text: "Unfinished human read before process exit", resume: false });
    await application.stop(); application = undefined;
    await engine.close();
    engine = await createManagedOpencodeServer({ ...engineOptions, service: { configDirectory: join(root, "config"), stateDirectory: join(root, "state") } });
    const restarted = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    await restarted.model.list({ location });
    expect(await restarted.rpc(legalMemoryRpc).cleanup({}, { location })).toEqual({ removed: 1 });
    expect((await restarted.session.list({ directory })).data.some(session => session.metadata?.legalworkInternal === "legalmemory")).toBe(false);
    expect(await restarted.session.active()).toEqual({}); expect(modelCalls).toBe(0);

  } finally { await application?.stop(); await engine?.close(); provider.stop(true); redirectTarget.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60_000);
