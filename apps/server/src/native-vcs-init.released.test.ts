import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { ApiError } from "./errors.js";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { proxyOpencodeRequest } from "./server.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("repository initialization is blocked through LegalWork while released native initialization and existing repository reads remain functional", async () => {
  const engine = await nativeMcpEngine({ policies: [{ action: "provider.use", resource: "*", effect: "deny" }] });
  const connection = engine.connection();
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", configPath: join(engine.root, "server.json"),
    workspaces: [{ id: "matter", name: "Matter", path: engine.directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [engine.directory],
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password };
  const workspace = config.workspaces[0]!;
  const proxy = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    try { return await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: url.pathname, actor: { type: "remote", scope: "collaborator" } }); }
    catch (error) { return Response.json({ code: error instanceof ApiError ? error.code : "fixture_error", message: error instanceof Error ? error.message : "Fixture error" }, { status: error instanceof ApiError ? error.status : 500 }); }
  } });
  try {
    const location = engine.location, publicClient = OpenCode.make({ baseUrl: proxy.url.origin });
    expect(existsSync(join(engine.directory, ".git"))).toBe(false);
    const blocked = await fetch(`${proxy.url.origin}/api/vcs/init?location[directory]=${encodeURIComponent(engine.directory)}&provider=git`, { method: "POST" });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe("coding_workflow_unavailable");
    expect(existsSync(join(engine.directory, ".git"))).toBe(false);
    // Positive control: this release and system can initialize a repository.
    // Only LegalWork's product boundary denies its dedicated setup API.
    await engine.client().vcs.init({ location, provider: "git" });
    expect(existsSync(join(engine.directory, ".git"))).toBe(true);
    expect((await publicClient.vcs.status({ location })).data).toEqual([]);
    expect((await publicClient.vcs.diff({ location, mode: "working" })).data).toEqual([]);
    expect(await engine.client().session.active()).toEqual({});
  } finally { proxy.stop(true); await engine.close(); }
}, 30_000);
