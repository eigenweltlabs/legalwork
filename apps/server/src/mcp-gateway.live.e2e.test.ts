import { closeTestRuntime, removeTestDirectory } from "./runtime.test-helpers.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { LocalMcpGateway } from "./mcp-gateway.js";
import { initializeMcpManager, stopMcpManager } from "./mcp-manager.js";
import { addMcp, runtimeMcpMapForWorkspace } from "./mcp.js";
import type { ServerConfig } from "./types.js";

test.skipIf(process.env.LEGALWORK_LIVE_MCP !== "1")("real Cloudflare documentation discovery and search through the managed gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-live-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "isolated-app", hostToken: "isolated-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    workspaces: [{ id: "live", name: "Live", path: workspace, preset: "starter", workspaceType: "local" }],
  };
  const manager = initializeMcpManager(config);
  const gateway = new LocalMcpGateway(manager);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/mcp\/gateway\/([^/]+)\/([^/]+)$/);
    if (!match) return new Response(null, { status: 404 });
    return gateway.handle(request, match[1]!, match[2]!);
  } });
  config.port = listener.port ?? 0;
  const client = new Client({ name: "LegalWork live verification", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    await addMcp(config, "live", "cloudflare", { type: "remote", url: "https://docs.mcp.cloudflare.com/mcp", oauth: false });
    const entries = await manager.engineEntries("live", await runtimeMcpMapForWorkspace(config, "live"));
    const endpoint = z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }).parse(entries.cloudflare);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
    const tools = await client.listTools();
    const search = tools.tools.find(tool => tool.name === "search_cloudflare_documentation");
    expect(search).toBeDefined();
    if (!search) throw new Error("Cloudflare documentation search tool was not discovered");
    const result = await client.callTool({ name: search.name, arguments: { query: "Cloudflare Workers bindings" } });
    expect(result.isError).not.toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    console.log(JSON.stringify({ platform: process.platform, engineProtocol: client.getProtocolEra(), tool: search.name, toolCount: tools.tools.length, resultBlocks: result.content.length }));
  } finally {
    await client.close();
    await gateway.close();
    await stopMcpManager(config);
    listener.stop(true);
    await closeTestRuntime(config);
    await removeTestDirectory(root);
  }
}, 120000);
