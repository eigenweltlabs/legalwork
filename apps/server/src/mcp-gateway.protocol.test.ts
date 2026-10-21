import { closeTestRuntime, removeTestDirectory } from "./runtime.test-helpers.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client, StreamableHTTPClientTransport, type ClientCapabilities } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ListRootsRequestSchema, CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import { LocalMcpGateway } from "./mcp-gateway.js";
import { initializeMcpManager, stopMcpManager } from "./mcp-manager.js";
import { addMcp, runtimeMcpMapForWorkspace } from "./mcp.js";
import { probeMcpServer } from "./mcp-probe.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const entrySchema = z.object({ url: z.string(), headers: z.record(z.string(), z.string()) });
const textSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });

async function fixture(compressedDiscovery = false) {
  const root = await mkdtemp(join(tmpdir(), "mcp-protocol-"));
  cleanups.push(() => removeTestDirectory(root));
  const received: Array<{ method: string; authorization: string | null; cookie: string | null; session: string | null }> = [];
  let cancelled = 0;
  let started = () => {};
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "modern-only", version: "2026-07-28" }, { capabilities: { tools: { listChanged: true }, completions: {}, tasks: {} } });
    server.registerTool("echo", { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({ content: [{ type: "text", text }], _meta: { "fixture/retained": true } }));
    server.registerTool("wait", { inputSchema: z.object({}) }, async (_args, ctx) => {
      started();
      await new Promise<void>(resolve => ctx.mcpReq.signal.addEventListener("abort", () => { cancelled++; resolve(); }, { once: true }));
      return { content: [{ type: "text", text: "cancelled" }] };
    });
    server.registerTool("url", { inputSchema: z.object({}) }, (_args, ctx) => {
      if (!ctx.mcpReq.inputResponses) return inputRequired({ inputRequests: { login: inputRequired.elicitUrl({ message: "Continue", url: "https://example.com/confirm" }) }, requestState: "url-round" });
      return { content: [{ type: "text", text: JSON.stringify(inputResponse(ctx.mcpReq.inputResponses, "login")) }] };
    });
    server.registerTool("interactive", { inputSchema: z.object({ workspace: z.string() }) }, ({ workspace }, ctx) => {
      if (!ctx.mcpReq.inputResponses) return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({ message: workspace, requestedSchema: z.object({ workspace: z.string() }) }),
          roots: inputRequired.listRoots(),
          sample: inputRequired.createMessage({ messages: [{ role: "user", content: { type: "text", text: workspace } }], maxTokens: 16 }),
        }, requestState: "opaque-round-state",
      });
      const confirm = inputResponse(ctx.mcpReq.inputResponses, "confirm");
      const roots = inputResponse(ctx.mcpReq.inputResponses, "roots");
      const sample = inputResponse(ctx.mcpReq.inputResponses, "sample");
      return { content: [{ type: "text", text: JSON.stringify({ workspace, confirm, roots, sample, state: ctx.mcpReq.requestState() }) }] };
    });
    server.registerResource("fixture", "fixture://document", {}, () => ({ contents: [{ uri: "fixture://document", text: "document" }] }));
    server.registerPrompt("fixture", {}, () => ({ messages: [{ role: "user", content: { type: "text", text: "prompt" } }] }));
    server.server.setRequestHandler("completion/complete", () => ({ completion: { values: ["completed"], total: 1, hasMore: false } }));
    server.server.setRequestHandler("tasks/get", { params: z.object({ taskId: z.string() }), result: z.object({ taskId: z.string(), status: z.string() }) }, params => ({ taskId: params.taskId, status: "completed" }));
    return server;
  }, { legacy: "reject" });
  cleanups.push(() => handler.close());
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const message = z.object({ method: z.string() }).parse(await request.clone().json());
    received.push({ method: message.method, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), session: request.headers.get("mcp-session-id") });
    const response = await handler.fetch(request);
    if (compressedDiscovery && message.method === "server/discover") {
      const bytes = Bun.gzipSync(new Uint8Array(await response.arrayBuffer()));
      return new Response(bytes, { status: response.status, headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(bytes.length) } });
    }
    return response;
  } });
  cleanups.push(() => provider.stop(true));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "app-token", hostToken: "host-token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    workspaces: ["a", "b"].map(id => ({ id, name: id, path: join(root, id), preset: "starter", workspaceType: "local" })),
  };
  for (const workspace of config.workspaces) await mkdir(workspace.path);
  const manager = initializeMcpManager(config);
  cleanups.push(() => closeTestRuntime(config));
  cleanups.push(() => stopMcpManager(config));
  const gateway = new LocalMcpGateway(manager);
  cleanups.push(() => gateway.close());
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/mcp\/gateway\/([^/]+)\/([^/]+)$/);
    if (!match) return new Response(null, { status: 404 });
    try { return await gateway.handle(request, match[1]!, match[2]!); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "failed" }, { status: 503 }); }
  } });
  config.port = listener.port ?? 0;
  cleanups.push(() => listener.stop(true));
  await addMcp(config, "a", "fixture", { type: "remote", url: `http://127.0.0.1:${provider.port}/mcp`, oauth: false, headers: { Authorization: "Bearer provider-only" } });
  const entry = async (workspace: string) => entrySchema.parse((await manager.engineEntries(workspace, await runtimeMcpMapForWorkspace(config, workspace))).fixture);
  const modern = async (capabilities: ClientCapabilities = {}, workspace = "a") => {
    const endpoint = await entry(workspace);
    const client = new Client({ name: "modern", version: "1" }, { capabilities, versionNegotiation: { mode: "auto" } });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { ...endpoint.headers, Cookie: "never-forward" } } }));
    return client;
  };
  return { config, manager, handler, received, entry, modern, waiting, cancelled: () => cancelled };
}

test("a modern-only server passes the Add connector discovery probe", async () => {
  const f = await fixture();
  const record = f.manager.store.all()[0];
  if (!record) throw new Error("No fixture connector");
  for (const exactUrl of [false, true]) expect(await probeMcpServer(record.config.url, { exactUrl })).toMatchObject({ auth: "none", reachable: true, transport: "streamable-http" });
  expect(f.received.map(message => message.method)).toEqual(["initialize", "server/discover", "initialize", "server/discover"]);
});

test("2026-07-28 MCP stays stateless through the gateway, including metadata, resources, prompts and Tasks extension requests", async () => {
  const f = await fixture();
  const client = await f.modern({ elicitation: { form: {} }, roots: {}, sampling: {} });
  client.setRequestHandler("elicitation/create", () => ({ action: "accept", content: { workspace: "modern" } }));
  client.setRequestHandler("roots/list", () => ({ roots: [{ uri: "file:///modern" }] }));
  client.setRequestHandler("sampling/createMessage", () => ({ role: "assistant", model: "modern", content: { type: "text", text: "modern" } }));
  expect(client.getProtocolEra()).toBe("modern");
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain("echo");
  expect(await client.callTool({ name: "echo", arguments: { text: "modern" } })).toMatchObject({ content: [{ type: "text", text: "modern" }], _meta: { "fixture/retained": true } });
  expect((await client.readResource({ uri: "fixture://document" })).contents[0]).toMatchObject({ text: "document" });
  expect((await client.getPrompt({ name: "fixture" })).messages[0]?.content).toMatchObject({ text: "prompt" });
  expect(await client.request({ method: "tasks/get", params: { taskId: "task-1" } }, z.object({ taskId: z.string(), status: z.string() }))).toEqual({ taskId: "task-1", status: "completed" });
  const interactive = textSchema.parse(await client.callTool({ name: "interactive", arguments: { workspace: "modern" } }));
  expect(JSON.parse(interactive.content[0]!.text)).toMatchObject({ workspace: "modern", roots: { roots: [{ uri: "file:///modern" }] }, state: "opaque-round-state" });
  expect(f.received.length).toBeGreaterThan(7);
  expect(f.received.every(message => message.authorization === "Bearer provider-only" && message.cookie === null && message.session === null)).toBe(true);
});

test("2026 subscriptions/listen streams and catalog notifications pass through the authenticated gateway", async () => {
  const f = await fixture();
  const client = await f.modern();
  let changed = 0;
  client.setNotificationHandler("notifications/tools/list_changed", () => { changed++; });
  const subscription = await client.listen({ toolsListChanged: true });
  cleanups.push(() => subscription.close());
  expect(subscription.honoredFilter.toolsListChanged).toBe(true);
  f.handler.notify.toolsChanged();
  for (let i = 0; i < 100 && changed === 0; i++) await Bun.sleep(10);
  expect(changed).toBe(1);
});

test("modern URL elicitation passes through without dropping its continuation state", async () => {
  const f = await fixture();
  const client = await f.modern({ elicitation: { url: {} } });
  client.setRequestHandler("elicitation/create", message => {
    expect(message.params).toMatchObject({ mode: "url", url: "https://example.com/confirm" });
    return { action: "accept" };
  });
  const answer = textSchema.parse(await client.callTool({ name: "url" }));
  expect(JSON.parse(answer.content[0]!.text)).toMatchObject({ action: "accept" });
});

test("closing a modern request cancels the upstream operation without disconnecting another workspace", async () => {
  const f = await fixture();
  const a = await f.modern();
  const b = await f.modern({}, "b");
  const abort = new AbortController();
  const pending = a.callTool({ name: "wait" }, { signal: abort.signal }).catch(() => "cancelled");
  await f.waiting;
  abort.abort();
  expect(await pending).toBe("cancelled");
  for (let i = 0; i < 100 && !f.cancelled(); i++) await Bun.sleep(10);
  expect(f.cancelled()).toBe(1);
  expect(await b.callTool({ name: "echo", arguments: { text: "still connected" } })).toMatchObject({ content: [{ text: "still connected" }] });
});

test("legacy engine sessions bridge modern MRTR elicitation, sampling and roots to the correct workspace concurrently", async () => {
  const f = await fixture();
  const clients = await Promise.all(["a", "b"].map(async workspace => {
    const endpoint = await f.entry(workspace);
    const client = new LegacyClient({ name: workspace, version: "1" }, { capabilities: { elicitation: { form: {} }, roots: {}, sampling: {} } });
    cleanups.push(() => client.close());
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: "accept", content: { workspace } }));
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: `file:///workspace-${workspace}` }] }));
    client.setRequestHandler(CreateMessageRequestSchema, () => ({ role: "assistant", model: workspace, content: { type: "text", text: workspace } }));
    await client.connect(new LegacyTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.headers },
      // A standalone GET stream is optional: related server requests must be
      // deliverable on the originating POST's response stream.
      fetch: (input, init) => init?.method === "GET" ? Promise.resolve(new Response(null, { status: 405 })) : fetch(input, init),
    }));
    return { client, workspace };
  }));
  const results = await Promise.all(clients.flatMap(({ client, workspace }) => [0, 1].map(async round => {
    expect((await client.complete({ ref: { type: "ref/prompt", name: "fixture" }, argument: { name: "value", value: "c" } })).completion.values).toEqual(["completed"]);
    const requestWorkspace = `${workspace}:${round}`;
    const answer = textSchema.parse(await client.callTool({ name: "interactive", arguments: { workspace: requestWorkspace } }));
    return { workspace, requestWorkspace, text: answer.content[0]!.text };
  })));
  for (const { workspace, requestWorkspace, text } of results) {
    expect(JSON.parse(text)).toMatchObject({ workspace: requestWorkspace, confirm: { kind: "elicit", content: { workspace } }, roots: { kind: "roots", roots: [{ uri: `file:///workspace-${workspace}` }] }, sample: { kind: "sampling", result: { model: workspace } }, state: "opaque-round-state" });
  }
});

test("compressed upstream discovery is decoded exactly once by the gateway and its client", async () => {
  const f = await fixture(true);
  const client = await f.modern();
  expect(client.getProtocolEra()).toBe("modern");
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  expect(await f.manager.status("a", "fixture")).toEqual({ status: "connected" });
});
