import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { writeSandboxDefault } from "../agent-sandbox/settings.js";

test("raw HTTP route retains actor/session/agent boundaries and complete bodies", async () => {
  const childRoot = process.env.LEGALWORK_RAW_HTTP_ROUTE_FIXTURE;
  if (!childRoot) {
    const root = await mkdtemp(join(tmpdir(), "legalwork-raw-http-route-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.filename], { env: { ...process.env, LEGALWORK_RAW_HTTP_ROUTE_FIXTURE: root }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, output: code === 0 ? "passed" : out + err }).toEqual({ code: 0, output: "passed" });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    return;
  }
  const directory = join(childRoot, "matter"); await mkdir(directory);
  let sent = 0, nativeReads = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { sent++; return new Response(await request.bytes(), { status: 201 }); } });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    nativeReads++;
    const path = new URL(request.url).pathname, location = { directory };
    if (path === "/api/model") return Response.json({ location, data: [] });
    if (path === "/api/config") return Response.json([]);
    if (path === "/api/agent") return Response.json({ location, data: [{ id: "legalwork", permissions: [] }] });
    if (path.startsWith("/api/session/")) return Response.json({ data: { id: path.split("/").pop(), location: path.endsWith("/foreign") ? { directory: childRoot } : location } });
    return new Response("Not found", { status: 404 });
  } });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(childRoot, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 5000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], opencodeBaseUrl: engine.url.origin, readOnly: false, agentSandboxEnabled: true, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  await writeSandboxDefault(config, { enabled: false, networkMode: "allow" });
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer client", "content-type": "application/json" };
  const input = { sessionID: "chat", agent: "legalwork", url: destination.url.href, method: "POST", headers: {}, bodyBase64: Buffer.alloc(5 * 1024 * 1024 + 7, 0xff).toString("base64") };
  const post = (body: unknown, authorization = "Bearer client") => fetch(base + "/workspace/matter/sandbox/http", { method: "POST", headers: { ...headers, authorization }, body: JSON.stringify(body) });
  try {
    const small = { ...input, bodyBase64: "AA==" };
    expect((await post(small, "Bearer owt_retired_viewer")).status).toBe(401);
    expect((await post(small, "Bearer unknown")).status).toBe(401);
    expect(nativeReads).toBe(0); expect(sent).toBe(0);
    expect((await post({ ...input, sessionID: "foreign" })).status).toBe(404);
    expect((await post({ ...input, agent: "unavailable" })).status).toBe(403);
    expect(sent).toBe(0);
    const response = await post(input);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ status: 201, url: destination.url.href, redirected: false });
    expect(result.bodyBase64).toBe(input.bodyBase64); expect(sent).toBe(1);
    await writeSandboxDefault(config, { enabled: true, networkMode: "block" });
    expect((await post(input)).status).toBe(403); expect(sent).toBe(1);
  } finally { await server.stop(); await engine.stop(true); await destination.stop(true); }
});
