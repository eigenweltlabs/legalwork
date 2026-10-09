import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { networkModeSchema, readSandboxNetworkMode } from "./settings.js";

test("network settings API authenticates, validates, persists and respects read-only mode", async () => {
  const childRoot = process.env.LEGALWORK_NETWORK_API_TEST_ROOT;
  if (!childRoot) {
    const root = await mkdtemp(join(tmpdir(), "sandbox-network-api-"));
    // The full server owns process-lifetime database caches. Exit the fixture
    // process before deleting its profile so Windows releases every handle.
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.filename], {
        env: { ...process.env, LEGALWORK_NETWORK_API_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return;
  }
  const root = childRoot;
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    configPath: join(root, "private", "server.json"), approval: { mode: "auto", timeoutMs: 5000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, agentSandboxEnabled: true, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}`;
  const hostHeaders = { "x-legalwork-host-token": "host", "content-type": "application/json" };
  const patch = (body: unknown, token?: string) => fetch(base + "/sandbox/network", { method: "PATCH", headers: {
    "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  try {
    expect((await patch({ mode: "allow" })).status).toBe(401);
    const issued = await fetch(base + "/tokens", { method: "POST", headers: hostHeaders, body: JSON.stringify({ scope: "viewer", label: "network-policy-test" }) });
    expect(issued.status).toBe(201);
    const viewer = await issued.json();
    expect((await patch({ mode: "allow" }, viewer.token)).status).toBe(403);
    for (const body of [{ mode: "unknown" }, { mode: "allow", extra: true }, { mode: null }, {}]) {
      expect((await patch(body, "client")).status).toBe(400);
      expect(await readSandboxNetworkMode(config)).toBe("approve");
    }
    for (const mode of networkModeSchema.options) {
      const response = await patch({ mode }, "client");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ networkMode: mode });
      expect(await readSandboxNetworkMode(config)).toBe(mode);
    }
    const folder = join(root, "matter");
    await mkdir(folder);
    config.workspaces.push({ id: "matter", name: "Matter", path: folder, preset: "starter", workspaceType: "local" });
    config.authorizedRoots.push(folder);
    const engine = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/agent"
      ? Response.json([{ name: "build", permission: [{ permission: "*", pattern: "*", action: "allow" }] }])
      : Response.json({ id: new URL(request.url).pathname.split("/").pop(), directory: folder }) });
    config.opencodeBaseUrl = engine.url.origin;
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { bash: "ask", read: "allow" } }));
    const commands = Array.from({ length: 10 }, (_, index) => fetch(base + "/workspace/matter/sandbox/execute", {
      method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" },
      body: JSON.stringify({ command: "echo test", agent: "build", sessionID: `chat-${index}`, description: "Read a public source" }),
    }));
    try {
      const schema = z.object({ items: z.array(z.object({ id: z.string(), workspaceId: z.string(), sessionID: z.string(), description: z.string() })) });
      let pending: z.infer<typeof schema>["items"] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        pending = schema.parse(await (await fetch(base + "/approvals", { headers: hostHeaders })).json()).items;
        if (pending.length === 10) break;
        await Bun.sleep(10);
      }
      expect(pending).toHaveLength(10);
      expect(new Set(pending.map((item) => item.sessionID)).size).toBe(10);
      const request = pending[0];
      const reply = (body: unknown, headers: Record<string, string>) => fetch(`${base}/approvals/${request.id}`, { method: "POST", headers, body: JSON.stringify(body) });
      expect((await reply({ reply: "allow", workspaceId: request.workspaceId, sessionID: request.sessionID }, { authorization: "Bearer client", "content-type": "application/json" })).status).toBe(401);
      expect((await reply({ reply: "allow", workspaceId: request.workspaceId, sessionID: "wrong-chat" }, hostHeaders)).status).toBe(409);
      expect((await reply({ reply: "allow", workspaceId: "wrong-workspace", sessionID: request.sessionID }, hostHeaders)).status).toBe(409);
      expect(schema.parse(await (await fetch(base + "/approvals", { headers: hostHeaders })).json()).items).toHaveLength(10);
      for (const item of pending) expect((await fetch(`${base}/approvals/${item.id}`, { method: "POST", headers: hostHeaders,
        body: JSON.stringify({ reply: "deny", workspaceId: item.workspaceId, sessionID: item.sessionID }) })).status).toBe(200);
      expect((await Promise.all(commands)).map((response) => response.status)).toEqual(Array(10).fill(403));
      expect((await reply({ reply: "allow", workspaceId: request.workspaceId, sessionID: request.sessionID }, hostHeaders)).status).toBe(404);
    } finally { engine.stop(true); }
    config.readOnly = true;
    expect((await patch({ mode: "allow" }, "client")).status).toBe(403);
    expect(await readSandboxNetworkMode(config)).toBe("approve");
  } finally {
    await server.stop();
    await closeRuntimeOpencodeConfig(config);
  }
}, 30000);
