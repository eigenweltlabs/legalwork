import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { proxyOpencodeRequest } from "./server.js";
import { announceSyncChange } from "./app-sync-events.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";
import { ApprovalService } from "./approvals.js";
import { ReloadEventStore } from "./events.js";
import { TokenService } from "./tokens.js";
import { matchRoute, type Route } from "./routes/registry.js";
import { disconnectEngineCredential, engineCredentialMetadata, registerEngineCredentialRoutes } from "./routes/engine-credentials.js";

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("released native client crosses the real proxy without location, file, session or vault bypasses", async () => {
  const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
  if (!binary) throw new Error("An explicitly selected engine is required.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-proxy-")));
  const a = join(root, "a"), b = join(root, "b");
  await Promise.all(["home", "config", "data", "state", "cache", "a", "b"].map(name => mkdir(join(root, name), { recursive: true })));
  const engine = await createManagedOpencodeServer({ bin: binary, cwd: a, timeoutMs: 30_000, env: {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", name: "Fixture", settings: { baseURL: "http://127.0.0.1:1/v1" }, models: { fixture: { name: "Fixture", capabilities: { tools: true } } } } } }),
  } });
  const privateClient = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "a", name: "A", path: a, preset: "starter", workspaceType: "local" }, { id: "b", name: "B", path: b, preset: "starter", workspaceType: "local" }], authorizedRoots: [a, b], readOnly: false, agentSandboxEnabled: true,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, opencodeBaseUrl: engine.url, opencodeUsername: engine.username, opencodePassword: engine.password };
  const routes: Route[] = [];
  registerEngineCredentialRoutes({ routes, config, jsonResponse: data => Response.json(data), requireClientScope(ctx) { if (ctx.actor?.scope === "viewer") throw new ApiError(403, "forbidden", "Read-only connection."); }, ensureWritable() {}, resolveWorkspace: async (_config, id) => {
    const workspace = config.workspaces.find(item => item.id === id); if (!workspace) throw new ApiError(404, "workspace_not_found", "Missing"); return workspace;
  } });
  const approvals = new ApprovalService(config.approval); const reloadEvents = new ReloadEventStore(); const tokens = new TokenService(config);
  const proxy = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url); const mount = url.pathname.match(/^\/w\/([^/]+)\/opencode(.*)$/);
    const workspace = config.workspaces.find(item => item.id === mount?.[1]);
    try {
      const route = matchRoute(routes, request.method, url.pathname);
      if (route) return await route.handler({ config, request, url, params: route.params, approvals, reloadEvents, tokens, actor: { type: "remote", scope: request.headers.get("x-test-scope") === "viewer" ? "viewer" : "collaborator" } });
      return await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: mount?.[2], actor: { type: "remote", scope: "collaborator" } });
    }
    catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Failed" }, { status: error instanceof ApiError ? error.status : 500 }); }
  } });
  try {
    const client = OpenCode.make({ baseUrl: `${proxy.url.toString().replace(/\/$/, "")}/w/a/opencode` });
    expect((await client.server.info()).version).toBe(await expectedOpencodeVersion(binary));
    expect((await client.location.get({ location: { directory: a } })).directory).toBe(a);
    await expect(client.location.get({ location: { directory: b } })).rejects.toThrow();
    const sessionA = await privateClient.session.create({ title: "A", location: { directory: a } });
    const sessionB = await privateClient.session.create({ title: "B", location: { directory: b } });
    const internal = await privateClient.session.create({ title: "Internal LegalMemory read", location: { directory: a }, metadata: { legalworkInternal: "legalmemory" } });
    expect((await client.session.get({ sessionID: sessionA.id })).id).toBe(sessionA.id);
    await expect(client.session.get({ sessionID: sessionB.id })).rejects.toThrow();
    await expect(client.session.list({ directory: b })).rejects.toThrow();
    expect((await client.session.list({ directory: a })).data.map(session => session.id)).toContain(sessionA.id);
    expect((await client.session.list({ directory: a })).data.map(session => session.id)).not.toContain(internal.id);
    await expect(client.session.get({ sessionID: internal.id })).rejects.toThrow();
    await expect(client.session.create({ location: { directory: a }, metadata: { legalworkInternal: "legalmemory" } })).rejects.toThrow();
    const payload = new TextEncoder().encode("complete-file-content\n".repeat(20_000));
    await client.file.write({ location: { directory: a }, path: join(a, "complete.txt"), payload });
    expect(await readFile(join(a, "complete.txt"))).toEqual(Buffer.from(payload));
    expect(await client.file.read({ location: { directory: a }, path: join(a, "complete.txt") })).toEqual(payload);
    await expect(client.file.write({ location: { directory: a }, path: join(b, "forbidden.txt"), payload })).rejects.toThrow();
    const shell = await fetch(`${proxy.url}w/a/opencode/api/session/${sessionA.id}/%73hell`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo forbidden" }) });
    expect(shell.status).toBe(403);
    const eventsController = new AbortController();
    const events = await fetch(`${proxy.url}w/a/opencode/api/event`, { signal: eventsController.signal });
    if (!events.body) throw new Error("Native events did not stream.");
    const reader = events.body.getReader(); const decoder = new TextDecoder();
    let frames = "";
    const readUntil = async (predicate: () => boolean) => {
      const timeout = setTimeout(() => eventsController.abort(), 10_000);
      try {
        while (!predicate()) {
          const chunk = await reader.read();
          if (chunk.done) return;
          frames += decoder.decode(chunk.value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    };
    await readUntil(() => frames.includes("server.connected"));
    const outside = join(root, "unregistered"); await mkdir(outside);
    const hidden = await privateClient.session.create({ title: "Unregistered", location: { directory: outside } });
    const transient = await privateClient.session.create({ title: "Internal operation", location: { directory: a }, metadata: { legalworkInternal: "legalmemory" } });
    await privateClient.session.synthetic({ sessionID: transient.id, text: "Private operation source", resume: false });
    const visible = await privateClient.session.create({ title: "Other authorized project", location: { directory: b } });
    await readUntil(() => frames.includes(visible.id));
    expect(frames).toContain(visible.id); expect(frames).not.toContain(hidden.id);
    expect(frames).not.toContain(transient.id);
    expect(frames).not.toContain("Private operation source");
    await privateClient.session.remove({ sessionID: transient.id });
    announceSyncChange(config, "projects");
    const revoked = setTimeout(() => eventsController.abort(), 10_000);
    try { while (!(await reader.read()).done) { /* Drain authorized frames already sent. */ } }
    finally { clearTimeout(revoked); eventsController.abort(); reader.releaseLock(); }
    await privateClient.credential.create({ integrationID: "fixture", value: { type: "key", key: "synthetic-private-value" }, label: "Synthetic account", activate: true });
    await privateClient.credential.create({ integrationID: "unrelated", value: { type: "key", key: "synthetic-unrelated-value" }, label: "Other", activate: true });
    await expect(client.credential.list()).rejects.toThrow();
    await privateClient.model.list({ location: { directory: a } });
    const metadataResponse = await fetch(`${proxy.url}workspace/a/providers/fixture/credentials`);
    expect(metadataResponse.status).toBe(200); expect(metadataResponse.headers.get("cache-control")).toBe("no-store");
    const metadata = await engineCredentialMetadata(privateClient, "fixture");
    const metadataText = await metadataResponse.text(); expect(metadataText).not.toContain("synthetic-private-value");
    expect((await fetch(`${proxy.url}workspace/a/providers/fixture/credentials`, { headers: { "x-test-scope": "viewer" } })).status).toBe(403);
    expect(metadata).toHaveLength(1); expect(JSON.stringify(metadata)).not.toContain("synthetic-private-value"); expect(metadata[0]).not.toHaveProperty("value");
    const unrelated = (await engineCredentialMetadata(privateClient, "unrelated"))[0];
    if (!unrelated || !metadata[0]) throw new Error("Synthetic credentials were not saved.");
    await expect(disconnectEngineCredential(privateClient, "fixture", unrelated.id)).rejects.toThrow();
    expect((await fetch(`${proxy.url}workspace/a/providers/fixture/credentials/${unrelated.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${proxy.url}workspace/a/providers/fixture/credentials/${metadata[0].id}`, { method: "DELETE" })).status).toBe(200);
    expect(await engineCredentialMetadata(privateClient, "fixture")).toEqual([]);
    expect(await engineCredentialMetadata(privateClient, "unrelated")).toHaveLength(1);
  } finally { await proxy.stop(true); await engine.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
