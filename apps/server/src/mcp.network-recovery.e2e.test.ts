import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OpenCode } from "@opencode/client";
import { nativeMcpBinary, nativeMcpEngine, nativeOAuthProvider } from "./native-mcp-engine.test-support.js";
import { beginNativeMcpOAuth, waitForNativeFixture, waitForNativeMcpOAuth } from "./native-mcp.test-support.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

// The only inference endpoint in this fixture is a deterministic loopback SSE
// provider. It verifies native direct/Code Mode execution, not real agent quality.
for (const codemode of [false, true]) {
test.skipIf(!nativeMcpBinary)(`OAuth MCPs recover in ${codemode ? "Code Mode" : "direct tools"} after an offline native rebuild without another sign-in or altered configuration`, async () => {
  let offline = false;
  const provider = await nativeOAuthProvider();
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (offline) return new Response("Temporary network outage", { status: 503 });
    const url = new URL(request.url), target = new URL(url.pathname + url.search, provider.url);
    if (url.pathname.includes(".well-known")) {
      const response = await fetch(target), text = (await response.text()).replaceAll(provider.url, url.origin);
      return new Response(text, { status: response.status, headers: response.headers });
    }
    const response = await fetch(target, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "manual" });
    // Challenge metadata must keep using the network relay during an outage.
    const headers = new Headers(response.headers);
    const challenge = headers.get("www-authenticate"); if (challenge) headers.set("www-authenticate", challenge.replaceAll(provider.url, url.origin));
    return new Response(response.body, { status: response.status, headers });
  } });
  const captures: Array<{ tools: string[]; catalog: string; results: string[] }> = [];
  let emitted = new Set<string>(), modelCalls = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("Unexpected model endpoint", { status: 404 });
    modelCalls++;
    const input = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]), messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })) }).parse(await request.json());
    const tools = input.tools.map(tool => tool.function.name);
    // Native v2 delivers its changing Code Mode catalog in user-level guidance.
    // Exclude tool results/assistant calls so they cannot masquerade as availability.
    const catalog = JSON.stringify(input.messages.filter(message => message.role === "system" || message.role === "user"));
    if (tools.length) captures.push({ tools, catalog, results: input.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)) });
    const next = ["notes", "tasks"].map(server => codemode
      ? tools.includes("execute") && catalog.includes(`${server}.mock_echo`) ? `${server}.mock_echo` : undefined
      : tools.find(name => name.includes(server) && name.includes("mock_echo"))).find(name => name && !emitted.has(name));
    if (next) emitted.add(next);
    const delta = next ? { tool_calls: [{ index: 0, id: `call_${next.replaceAll(".", "_")}`, type: "function", function: { name: codemode ? "execute" : next, arguments: JSON.stringify(codemode ? { code: `return await tools.${next}(${JSON.stringify({ text: `RECOVERED_${next}` })});` } : { text: `RECOVERED_${next}` }) } }] } : { content: "Synthetic connector check complete." };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "local-network-check", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, next ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const remote = { type: "remote", url: `${relay.url.origin}/mcp`, codemode, timeout: { startup: 1000, catalog: 1000, execution: 1000 } };
  const configuration = { mcp: { servers: { notes: remote, tasks: remote } }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    providers: { local: { package: "@opencode/ai/providers/openai-compatible", name: "Local fixture", settings: { baseURL: `${model.url.origin}/v1`, apiKey: "synthetic-local-only" }, models: { local: { name: "Local", capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } } } },
    policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "local", effect: "allow" }], model: "local/local", share: "disable", update: "disable", warming: false };
  const engine = await nativeMcpEngine(async root => {
    const probe = join(root, "probe"); await mkdir(probe);
    await writeFile(join(probe, "index.js"), `import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'legalwork.mcp-network-fixture',async setup(ctx){await ctx.rpc.register({id:'legalwork.mcp-network-fixture',methods:{tools:{input:{type:'object'},output:{type:'array',items:{type:'object'}}}},events:{}},{tools:async()=> (await ctx.tool.list()).map(tool=>({id:tool.id}))})}});`);
    return { ...configuration, plugins: [probe] };
  });
  const authored = join(engine.directory, "opencode.jsonc"), savedConfig = JSON.stringify(configuration);
  await writeFile(authored, savedConfig);
  const connection = engine.connection();
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "local-network-test", hostToken: "local-host-test", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
    opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
    workspaces: [{ id: "network", name: "Network check", path: engine.directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [engine.directory], configPath: join(engine.root, "legalwork.json"), startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const server = await startServer(config);
  const client = engine.client(), location = engine.location;
  const app = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}/workspace/network/opencode`, headers: { Authorization: `Bearer ${config.token}` } });
  const statuses = async () => Object.fromEntries((await client.mcp.list({ location })).data.map(server => [server.name, server.status.status]));
  async function prompt(execution = app) {
    captures.length = 0; emitted = new Set();
    const session = await execution.session.create({ location, title: "Synthetic network check", agent: "build", model: { providerID: "local", id: "local" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    await execution.session.prompt({ sessionID: session.id, text: "Read the synthetic notes and tasks through their connectors." });
    await waitForNativeFixture(async () => ({ active: await client.session.active(), captures: captures.length }), value => value.captures > 0 && !Object.hasOwn(value.active, session.id), "synthetic connector turn");
    const available = (name: string) => codemode
      ? captures[0]?.tools.includes("execute") && captures[0].catalog.includes(`${name}.mock_echo`)
      : captures[0]?.tools.some(tool => tool.includes(name) && tool.includes("mock_echo"));
    return {
      notesAvailable: available("notes"),
      tasksAvailable: available("tasks"),
      notesExecuted: captures.at(-1)?.results.some(result => result.includes("RECOVERED_") && result.includes("notes")),
      tasksExecuted: captures.at(-1)?.results.some(result => result.includes("RECOVERED_") && result.includes("tasks")),
    };
  }
  try {
    for (const name of ["notes", "tasks"]) {
      const attempt = await beginNativeMcpOAuth(client, location, name);
      expect((await fetch(attempt.url)).status).toBe(200);
      expect((await waitForNativeMcpOAuth(client, location, attempt)).status).toBe("complete");
      await client.mcp.connect({ location, server: name });
    }
    const savedCredentials = await client.credential.list();
    await waitForNativeFixture(statuses, status => status.notes === "connected" && status.tasks === "connected", "initial authenticated connectors");
    const nativeConfig = await client.config.get({ location });
    expect(nativeConfig.some(entry => entry.type === "document" && entry.info.mcp?.servers?.notes?.codemode === codemode)).toBe(true);
    // Native MCP tool reconciliation is deliberately debounced upstream.
    // Await observable tool registration rather than inserting a fixed sleep.
    await waitForNativeFixture(async () => z.array(z.object({ id: z.string() })).parse((await client.rpc.call({ rpcID: "legalwork.mcp-network-fixture", method: "tools", location, input: {} })).output), tools => tools.some(tool => tool.id.includes("notes") && tool.id.includes("mock_echo")) && tools.some(tool => tool.id.includes("tasks") && tool.id.includes("mock_echo")), "initial MCP tool catalog");
    const initial = await prompt();
    // Isolate upstream readiness from LegalWork admission and location reload:
    // remove both tools observably, reconnect using only the native API, then
    // immediately start a native task through the same Basic-auth client.
    for (const name of ["notes", "tasks"]) await client.mcp.disconnect({ location, server: name });
    await waitForNativeFixture(async () => z.array(z.object({ id: z.string() })).parse((await client.rpc.call({ rpcID: "legalwork.mcp-network-fixture", method: "tools", location, input: {} })).output), tools => !tools.some(tool => tool.id.includes("mock_echo") && (tool.id.includes("notes") || tool.id.includes("tasks"))), "disconnected native tool catalog");
    for (const name of ["notes", "tasks"]) await client.mcp.connect({ location, server: name });
    expect(await statuses()).toEqual({ notes: "connected", tasks: "connected" });
    const directReconnect = await prompt(client);
    await waitForNativeFixture(async () => z.array(z.object({ id: z.string() })).parse((await client.rpc.call({ rpcID: "legalwork.mcp-network-fixture", method: "tools", location, input: {} })).output), tools => tools.some(tool => tool.id.includes("notes") && tool.id.includes("mock_echo")) && tools.some(tool => tool.id.includes("tasks") && tool.id.includes("mock_echo")), "reconnected native tool catalog");
    const settledReconnect = await prompt(client);
    offline = true; await client.location.reload();
    await waitForNativeFixture(statuses, status => status.notes === "failed" && status.tasks === "failed", "offline connector failures");
    offline = false;
    await app.mcp.list({ location });
    await waitForNativeFixture(statuses, status => status.notes === "connected" && status.tasks === "connected", "status-refresh transport recovery");
    const statusRefresh = await prompt();
    expect(await client.credential.list()).toEqual(savedCredentials);
    expect(await readFile(authored, "utf8")).toBe(savedConfig);
    offline = true; await client.location.reload();
    await waitForNativeFixture(statuses, status => status.notes === "failed" && status.tasks === "failed", "second offline connector failures");
    offline = false;
    // Admission must recover tools even without a status-bar refresh.
    const promptAdmission = await prompt();
    expect(await statuses()).toEqual({ notes: "connected", tasks: "connected" });
    expect(await client.credential.list()).toEqual(savedCredentials);
    expect(await readFile(authored, "utf8")).toBe(savedConfig);
    expect(modelCalls).toBeGreaterThan(0);
    // Report both recovery paths in one run. A first-turn registration failure
    // must not prevent exercising admission without a status-bar refresh.
    const complete = { notesAvailable: true, tasksAvailable: true, notesExecuted: true, tasksExecuted: true };
    expect({ initial, directReconnect, settledReconnect, statusRefresh, promptAdmission }).toEqual({ initial: complete, directReconnect: complete, settledReconnect: complete, statusRefresh: complete, promptAdmission: complete });
  } finally { await server.stop(); await engine.close(); await provider.close(); relay.stop(true); model.stop(true); }
}, 60_000);
}
