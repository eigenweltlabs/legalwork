import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { waitForNativeFixture } from "../native-mcp.test-support.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { writeSandboxDefault, writeSessionSandbox, type NetworkMode } from "../agent-sandbox/settings.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { rawHttpOutputSchema } from "../agent-sandbox/raw-http-schema.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const marker = "private-response-must-not-enter-model-context:";
const traceSchema = z.object({ phase: z.enum(["before", "after"]), tool: z.string(), sessionID: z.string(), status: z.string().optional(), input: z.unknown(), result: z.unknown().optional() });
const approvalSchema = z.object({ items: z.array(z.object({ id: z.string(), sessionID: z.string().optional(), network: z.object({ complete: z.literal(true), sha256: z.string(), body: z.string(), bodyBytes: z.number(), headers: z.record(z.string(), z.string()) }).optional() })) });

test.skipIf(!binary)("compiled Code Mode fetch obeys production session policy with complete private transport and Stop", async () => {
  const childRoot = process.env.LEGALWORK_RAW_HTTP_ENGINE_FIXTURE;
  if (!childRoot) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-raw-http-")));
    // Full-server stores live for the process. Reap their owner before deleting
    // the profile, matching the existing full-server fixtures on Windows.
    try {
      const child = Bun.spawn([process.execPath, "test", "--preload", resolve(import.meta.dir, "../../test-preload.ts"),
        ...(process.env.LEGALWORK_TEST_CANDIDATE_DIRECTORY ? ["--preload", resolve(import.meta.dir, "../../../../packages/opencode-release/build/validation-preload.mjs")] : []),
        import.meta.filename], {
        env: { ...process.env, LEGALWORK_RAW_HTTP_ENGINE_FIXTURE: root }, stdout: "inherit", stderr: "inherit",
      });
      expect(await child.exited).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(existsSync(root)).toBe(false);
    return;
  }
  const providerRequests: unknown[] = [], hits: Array<{ path: string; method: string; headers: Record<string, string>; bytes: number; sha256: string }> = [];
  const codes = new Map<string, string>(), rounds = new Map<string, number>();
  const bodyStarted = new Map<string, () => void>();
  const bodiesClosed = new Set<string>();
  const responseBytes = Buffer.concat([Buffer.from(marker), Buffer.alloc(17 * 1024 * 1024 + 53, 99)]);
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url), body = await request.bytes();
    hits.push({ path: url.pathname, method: request.method, headers: Object.fromEntries(request.headers), bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    if (url.pathname === "/redirect") return new Response(null, { status: 307, headers: { location: `http://localhost:${target.port}/redirect-final` } });
    if (url.pathname.startsWith("/wait-")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); bodyStarted.get(url.pathname)?.(); }, cancel() { bodiesClosed.add(url.pathname); } }));
    if (url.pathname === "/large") return new Response(responseBytes, { status: 422, headers: { "x-result": "complete" } });
    return Response.json({ path: url.pathname, method: request.method, body: Buffer.from(body).toString(), authorization: request.headers.get("authorization") });
  } });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: unknown = await request.json(); providerRequests.push(body);
    const payload = z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()).optional() }).passthrough().parse(body);
    const primary = payload.tools?.some(tool => tool.name === "execute");
    expect(payload.tools?.some(tool => tool.name === "legalwork_raw_http")).not.toBe(true);
    const id = primary ? [...codes.keys()].find(id => JSON.stringify(body).includes(`scenario-[${id}]`)) : undefined;
    const round = id ? rounds.get(id) ?? 0 : 1;
    if (id) rounds.set(id, round + 1);
    const call = primary && id !== undefined && round === 0;
    const sequence = providerRequests.length, responseID = `response_${sequence}`;
    const item = call ? { type: "function_call", id: `function_${sequence}`, call_id: `call_${sequence}`, name: "execute", arguments: JSON.stringify({ code: codes.get(id) }), status: "completed" }
      : { type: "message", id: `message_${sequence}`, role: "assistant", content: [{ type: "output_text", text: "Done" }], status: "completed" };
    const events = [{ type: "response.created", response: { id: responseID, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "" } : item },
      ...(call ? [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }, { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments }] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: responseID, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  let server: Awaited<ReturnType<typeof startServer>> | undefined, config: ServerConfig | undefined;
  let journal = "", removeMarker = "";
  let sandboxBundle: Buffer | undefined, observerBundle: Buffer | undefined;
  const previous = { url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN, db: process.env.LEGALWORK_RUNTIME_DB, tokens: process.env.LEGALWORK_TOKEN_STORE };
  const results: Array<{ id: string; sessionID: string; messages: unknown }> = [];
  let pluginCatalog: unknown;
  let formContentType: string | undefined;
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine(async root => {
      const directory = join(root, "project"), plugin = join(root, "sandbox-plugin"), observer = join(root, "observer");
      for (const path of [plugin, observer]) await mkdir(path);
      journal = join(root, "private-raw-http.jsonl"); removeMarker = join(root, "remove-adapter");
      process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
      config = { host: "127.0.0.1", port: 0, token: "http-fixture-client", hostToken: "http-fixture-host", configPath: join(root, "server.json"),
        workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory], agentSandboxEnabled: true,
        readOnly: false, approval: { mode: "manual", timeoutMs: 30000 }, corsOrigins: [], startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
      await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { "*": "allow", webfetch: "allow" } }));
      await writeSandboxDefault(config, { enabled: true, networkMode: "block" });
      server = await startServer(config);
      process.env.LEGALWORK_SERVER_URL = `http://127.0.0.1:${server.port}`; process.env.LEGALWORK_SERVER_TOKEN = config.token;
      await buildNativePluginFixture(resolve(import.meta.dir, "legalwork-sandbox.ts"), join(plugin, "index.js"));
      sandboxBundle = await readFile(join(plugin, "index.js"));
      const observerSource = join(root, "observer.ts");
      await writeFile(observerSource, `import {appendFile} from "node:fs/promises";import{existsSync}from"node:fs";export default {id:"raw-http-fixture-observer",async setup(ctx){if(existsSync(${JSON.stringify(removeMarker)}))await ctx.tool.transform(editor=>editor.remove("legalwork_raw_http"));for(const phase of["before","after"])await ctx.tool.hook("execute."+phase,event=>appendFile(${JSON.stringify(journal)},JSON.stringify({phase,...event})+String.fromCharCode(10),{mode:384}));}};`);
      await buildNativePluginFixture(observerSource, join(observer, "index.js"));
      observerBundle = await readFile(join(observer, "index.js"));
      return { plugins: [{ package: plugin }, { package: observer }], model: "openai/fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }],
        providers: { openai: { settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "synthetic-local-only", transport: "http" }, models: { fixture: { modelID: "fixture", limit: { context: 128000, output: 4096 }, capabilities: { tools: true } } } } } };
    }, childRoot);
    if (!config || !server) throw new Error("HTTP fixture setup failed");
    const runningEngine = engine;
    const managedConfig = config, base = `http://127.0.0.1:${server.port}`, connection = runningEngine.connection();
    managedConfig.opencodeBaseUrl = connection.url; managedConfig.opencodeUsername = connection.username; managedConfig.opencodePassword = connection.password;
    const client = runningEngine.client(); await client.model.list({ location: runningEngine.location });
    const catalog = await client.plugin.list({ location: runningEngine.location }); pluginCatalog = catalog;
    expect(catalog.data.find(item => item.id === "raw-http-fixture-observer")?.state.status).toBe("active");
    type TestSession = Awaited<ReturnType<typeof client.session.create>>;
    const hostHeaders = { "x-legalwork-host-token": managedConfig.hostToken, "content-type": "application/json" };
    const approvals = async () => approvalSchema.parse(await (await fetch(base + "/approvals", { headers: hostHeaders })).json()).items;
    const run = async (id: string, mode: NetworkMode, code: string, during?: (session: TestSession) => Promise<void>) => {
      codes.set(id, code);
      const session = await client.session.create({ location: runningEngine.location, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
      await writeSessionSandbox(managedConfig, "matter", session.id, { enabled: true, networkMode: mode });
      await client.session.prompt({ sessionID: session.id, text: `scenario-[${id}]` });
      if (during) await during(session);
      // Fixture watchdog only: no product task deadline or output limit.
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(120000) });
      const messages = await client.message.list({ sessionID: session.id });
      results.push({ id, sessionID: session.id, messages });
      const completed = messages.data.flatMap(message => message.type === "assistant" ? message.content.flatMap(part =>
        part.type === "tool" && part.name === "execute" && part.state?.status === "completed" ? [part.state] : []) : []);
      const content = completed.flatMap(state => state.content.flatMap(part => part.type === "text" ? [part.text] : []));
      return { session, messages, completed, content, text: JSON.stringify(messages) };
    };
    const url = (path: string) => JSON.stringify(target.url.origin + path);
    const local = await run("local-offline", "block", 'const local=await(await fetch("data:text/plain,offline")).text();return {offline:local,value:6*7};');
    expect(JSON.parse(local.content[0])).toEqual({ offline: "offline", value: 42 }); expect(hits).toHaveLength(0);
    const hidden = await run("hidden-catalog", "block", 'const found=await search({query:"legalwork_raw_http"});return {direct:Object.keys(tools).includes("legalwork_raw_http"),listed:JSON.stringify(found).includes("legalwork_raw_http")};');
    expect(JSON.parse(hidden.content[0])).toEqual({ direct: false, listed: false }); expect(hits).toHaveLength(0);
    const block = await run("block", "block", `return await (await fetch(${url("/block")})).text();`);
    expect(block.text).toContain("blocked"); expect(hits).toHaveLength(0); expect(await approvals()).toHaveLength(0);
    await run("approve-deny", "approve", `return await (await fetch(${url("/approve-deny")})).text();`, async session => {
      const pending = await waitForNativeFixture(approvals, items => items.some(item => item.sessionID === session.id), "native HTTP approval");
      const approval = pending.find(item => item.sessionID === session.id);
      if (!approval) throw new Error("No approval");
      expect(approval.network).toMatchObject({ complete: true, bodyBytes: 0 }); expect(hits).toHaveLength(0);
      expect((await fetch(`${base}/approvals/${approval.id}`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ reply: "allow", workspaceId: "matter", sessionID: "other-chat" }) })).status).toBe(409);
      expect((await fetch(`${base}/approvals/${approval.id}`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ reply: "deny", workspaceId: "matter", sessionID: session.id }) })).ok).toBe(true);
    });
    expect(hits).toHaveLength(0);
    // Approve retains the existing private-address denial even after human approval.
    await run("approve-private", "approve", `return await (await fetch(${url("/approve-private")})).text();`, async session => {
      const pending = await waitForNativeFixture(approvals, items => items.some(item => item.sessionID === session.id), "private destination approval");
      const item = pending.find(item => item.sessionID === session.id); if (!item) throw new Error("No private request approval");
      await fetch(`${base}/approvals/${item.id}`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ reply: "allow", workspaceId: "matter", sessionID: session.id }) });
    });
    expect(hits).toHaveLength(0);
    const allowed = await run("allow", "allow", `const r=await fetch(${url("/allow")},{method:"POST",body:new URLSearchParams({a:"value space"})});return {status:r.status,result:await r.json()};`);
    expect(allowed.text).toContain("value+space"); expect(hits.at(-1)).toMatchObject({ path: "/allow", method: "POST" });
    formContentType = hits.at(-1)?.headers["content-type"];
    await writeRuntimeOpencodeConfig(managedConfig, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { "*": "allow", webfetch: "ask" } }));
    await run("permission-allow", "allow", `return await (await fetch(${url("/permission-allow")},{method:"POST",body:"r".repeat(40000)})).json();`, async session => {
      const pending = await waitForNativeFixture(approvals, items => items.some(item => item.sessionID === session.id), "full HTTP request review");
      const item = pending.find(item => item.sessionID === session.id); if (!item?.network) throw new Error("No complete request review");
      expect(item.network.body.length).toBe(40000); expect(item.network.sha256).toHaveLength(64);
      expect(hits.some(hit => hit.path === "/permission-allow")).toBe(false);
      expect((await fetch(`${base}/approvals/${item.id}`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ reply: "allow", workspaceId: "matter", sessionID: session.id }) })).ok).toBe(true);
    });
    expect(hits.at(-1)).toMatchObject({ path: "/permission-allow", bytes: 40000 });
    await writeRuntimeOpencodeConfig(managedConfig, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { "*": "allow", webfetch: "allow" } }));
    const redirect = await run("redirect", "allow", `const r=await fetch(${url("/redirect")},{method:"POST",headers:{authorization:"request-secret"},body:"preserved"});return {url:r.url,redirected:r.redirected,body:await r.json()};`);
    expect(redirect.text).toContain('redirected'); expect(hits.at(-2)).toMatchObject({ path: "/redirect", method: "POST", headers: { authorization: "request-secret" }, bytes: 9 });
    expect(hits.at(-1)).toMatchObject({ path: "/redirect-final", method: "POST", bytes: 9 }); expect(hits.at(-1)?.headers.authorization).toBeUndefined();
    await writeRuntimeOpencodeConfig(managedConfig, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { "*": "allow", webfetch: { "*": "allow", [`http://localhost:${target.port}/redirect-final`]: "deny" } } }));
    const beforeRedirectDeny = hits.length;
    await run("redirect-denied", "allow", `return await(await fetch(${url("/redirect")})).text();`);
    expect(hits.slice(beforeRedirectDeny).map(hit => hit.path)).toEqual(["/redirect"]);
    await writeRuntimeOpencodeConfig(managedConfig, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { "*": "allow", webfetch: "allow" } }));
    const large = await run("large", "allow", `const r=await fetch(${url("/large")},{method:"POST",body:"q".repeat(${5 * 1024 * 1024 + 37})});const b=await r.bytes();return {length:b.length,last:b[b.length-1],status:r.status,header:r.headers.get("x-result")};`);
    expect(hits.at(-1)?.bytes).toBe(5 * 1024 * 1024 + 37);
    expect(JSON.parse(large.content[0])).toEqual({ length: responseBytes.length, last: 99, status: 422, header: "complete" });
    const progress = z.object({ toolCalls: z.array(z.object({ tool: z.literal("fetch"), status: z.literal("completed"), input: z.object({ method: z.literal("POST"), url: z.string() }).strict() }).strict()) }).passthrough().parse(large.completed[0]?.metadata);
    expect(progress.toolCalls).toHaveLength(1);
    expect(JSON.stringify(providerRequests)).not.toContain(marker);
    await run("parallel", "allow", `return await Promise.all([fetch(${url("/parallel-a")}).then(r=>r.json()),fetch(${url("/parallel-b")}).then(r=>r.json())]);`);
    expect(hits.filter(hit => hit.path.startsWith("/parallel-"))).toHaveLength(2);
    for (const kind of ["stop", "revoke", "isolation"]) {
      let started = false; bodyStarted.set(`/wait-${kind}`, () => { started = true; });
      await run(kind, "allow", `return await (await fetch(${url(`/wait-${kind}`)})).bytes();`, async session => {
        await waitForNativeFixture(async () => started, Boolean, "native response body");
        if (kind === "isolation") {
          const before = hits.length;
          await run("other-chat-blocked", "block", `return await(await fetch(${url("/other-chat-blocked")})).text();`);
          expect(hits).toHaveLength(before); expect(bodiesClosed.has(`/wait-${kind}`)).toBe(false);
        }
        if (kind !== "revoke") await client.session.interrupt({ sessionID: session.id });
        else await writeSessionSandbox(managedConfig, "matter", session.id, { enabled: true, networkMode: "block" });
        expect(await waitForNativeFixture(async () => bodiesClosed.has(`/wait-${kind}`), Boolean, "stopped HTTP socket")).toBe(true);
      });
    }
    await writeFile(removeMarker, "remove only the reserved adapter for fail-closed proof");
    await client.location.reload(); await client.model.list({ location: runningEngine.location });
    const count = hits.length;
    const missing = await run("missing", "allow", `return await (await fetch(${url("/missing")})).text();`);
    expect(hits).toHaveLength(count); expect(missing.text).toContain("unavailable");
    const traces = (await readFile(journal, "utf8")).trim().split("\n").map(line => traceSchema.parse(JSON.parse(line)));
    const raw = traces.filter(trace => trace.tool === "legalwork_raw_http");
    const largeTrace = raw.find(trace => trace.phase === "after" && trace.status === "completed" && JSON.stringify(trace.input).includes("/large"));
    expect(largeTrace).toBeDefined();
    const output = z.object({ output: rawHttpOutputSchema }).parse(largeTrace?.result).output;
    expect(Buffer.from(output.bodyBase64, "base64").equals(responseBytes)).toBe(true);
    expect(raw.some(trace => trace.phase === "after" && trace.status === "error")).toBe(true);
    for (const id of ["block", "approve-deny", "approve-private", "redirect-denied", "revoke", "other-chat-blocked"]) {
      const sessionID = results.find(result => result.id === id)?.sessionID;
      expect(raw.find(trace => trace.sessionID === sessionID && trace.phase === "after")?.status).toBe("error");
    }
    const localID = results.find(result => result.id === "local-offline")?.sessionID;
    expect(raw.some(trace => trace.sessionID === localID)).toBe(false);
    expect(JSON.stringify(results)).not.toContain(Buffer.from(responseBytes).toString("base64"));
    expect(formContentType).toBe("application/x-www-form-urlencoded;charset=UTF-8");
  } finally {
    const evidence = process.env.LEGALWORK_RAW_HTTP_ACCEPTANCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      for (const [name, value] of [["results.json", results], ["hits.json", hits], ["provider-requests.json", providerRequests], ["plugins.json", pluginCatalog]]) await writeFile(join(evidence, String(name)), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      if (journal) await writeFile(join(evidence, "private-tool-trace.jsonl"), await readFile(journal).catch(() => Buffer.alloc(0)), { mode: 0o600 });
      if (sandboxBundle) await writeFile(join(evidence, "production-sandbox-plugin.mjs"), sandboxBundle, { mode: 0o600 });
      if (observerBundle) await writeFile(join(evidence, "observer-plugin.mjs"), observerBundle, { mode: 0o600 });
    }
    await server?.stop(); if (config) await closeRuntimeOpencodeConfig(config); await engine?.close(); provider.stop(true); target.stop(true);
    for (const [key, value] of Object.entries({ LEGALWORK_SERVER_URL: previous.url, LEGALWORK_SERVER_TOKEN: previous.token, LEGALWORK_RUNTIME_DB: previous.db, LEGALWORK_TOKEN_STORE: previous.tokens })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 240000);
