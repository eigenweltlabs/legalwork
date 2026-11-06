import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createEngineClient } from "./engine-client.js";
import { startServer } from "./server.js";
import { mcpRecovery } from "./workspace-mcp-recovery.js";
import { waitForNativeFixture } from "./native-mcp.test-support.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-mcp-admission-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const child = join(root, "nested"), outside = join(root, "..", `${root.split("/").at(-1)}-other`);
  await mkdir(child);
  const calls: Array<{ path: string; directory: string | null; body?: unknown }> = [];
  const state = { status: "failed", directory: root, metadata: {}, agent: "legalwork", enabled: true, removed: false,
    hold: Promise.resolve(), connects: 0, admissions: 0, locked: false };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    const body: unknown = ["GET", "HEAD"].includes(request.method) ? undefined : await request.json().catch(() => undefined);
    calls.push({ path, directory: url.searchParams.get("location[directory]"), body });
    if (path === "/api/session/chat" && request.method === "GET") return Response.json({ data: {
      id: "chat", projectID: "fixture", title: "Chat", agent: state.agent, location: { directory: state.directory }, metadata: state.metadata, time: { created: 1, updated: 1 },
    } });
    if (path === "/api/mcp") return Response.json({ location: { directory: state.directory }, data: [{ name: "notes", status: { status: state.status } }] });
    if (path === "/api/config") return Response.json([
      { type: "document", info: { mcp: { servers: { notes: { type: "remote", url: "https://connector.invalid/mcp", disabled: false } } } } },
      { type: "document", info: { mcp: { servers: state.removed ? {} : { notes: { type: "remote", url: "https://connector.invalid/mcp", disabled: !state.enabled } } } } },
    ].filter((_entry, index) => !state.removed || index === 1));
    if (path === "/api/experimental/mcp/notes/connect") {
      state.connects++; await state.hold; state.status = "connected";
      return new Response(null, { status: 204 });
    }
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session/chat/message") return Response.json({ data: [], cursor: {} });
    if (path === "/api/session/chat/inbox") return Response.json({ data: [] });
    if (path === "/api/session/chat/prompt") {
      state.admissions++;
      const input = z.object({ id: z.string().optional(), text: z.string() }).parse(body);
      return Response.json({ data: { id: input.id ?? "msg_fixture", type: "user", text: input.text, time: { created: 2 } } });
    }
    if (path === "/api/session/chat/command") { state.admissions++; return new Response(null, { status: 204 }); }
    if (path === "/api/session/chat" || /^\/api\/session\/chat\/(?:model|agent)$/.test(path)) return new Response(null, { status: 204 });
    return Response.json({ message: `Unexpected fixture endpoint ${path}` }, { status: 404 });
  } });
  cleanups.push(() => { engine.stop(true); });
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local", baseUrl: engine.url.origin };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", workspaces: [workspace],
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], authorizedRoots: [root], readOnly: false,
    startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    withManagedEngineAdmission: async (_sessionID, operation) => {
      if (state.locked) throw new Error("Nested lifecycle admission would deadlock");
      state.locked = true;
      try { return await operation(); } finally { state.locked = false; }
    } };
  return { root, child, outside, state, calls, config, workspace, client: createEngineClient(config, workspace), async app() {
    const server = await startServer(config); cleanups.push(() => server.stop());
    return (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}/workspace/matter/${path}`, {
      method: "POST", headers: { Authorization: "Bearer fixture-client", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } };
}

test.each(["prompt", "command"])("native %s reconnects before lifecycle admission and uses the saved session location", async kind => {
  const f = await fixture(); f.state.directory = f.child;
  if (kind === "prompt") await f.client.session.prompt({ sessionID: "chat", text: "Use notes" });
  else await f.client.session.command({ sessionID: "chat", name: "read-notes", text: "arguments" });
  expect(f.state.connects).toBe(1);
  expect(f.state.admissions).toBe(1);
  const reconnect = f.calls.findIndex(call => call.path.endsWith("/notes/connect"));
  const admission = f.calls.findIndex(call => call.path.endsWith(`/${kind}`));
  expect(reconnect).toBeLessThan(admission);
  expect(f.calls.filter(call => call.path === "/api/mcp" || call.path.endsWith("/notes/connect")).every(call => call.directory === f.child)).toBe(true);
});

test("public scoped proxy and durable queued prompt recover without polling connector status", async () => {
  for (const kind of ["proxy", "queue"]) {
    const f = await fixture(), request = await f.app();
    const response = kind === "proxy"
      ? await request("opencode/api/session/chat/prompt", { text: "Use notes" })
      : await request("sessions/chat/dispatch", { kind: "prompt", id: "msg_queued", text: "Use notes", model: { providerID: "fixture", id: "fixture" } });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    await waitForNativeFixture(async () => f.state.admissions, value => value === 1, `${kind} admission`);
    expect(f.state.connects).toBe(1);
    const reconnect = f.calls.findIndex(call => call.path.endsWith("/notes/connect"));
    expect(reconnect).toBeLessThan(f.calls.findIndex(call => call.path.endsWith("/prompt")));
    expect(f.state.locked).toBe(false);
  }
});

test("auth-pending, disabled, removed and isolated worker connectors are not reconnected", async () => {
  for (const kind of ["auth", "disabled", "removed", "review", "legalmemory"]) {
    const f = await fixture();
    if (kind === "auth") mcpRecovery(f.config).beginAuth("notes");
    if (kind === "disabled") f.state.enabled = false;
    if (kind === "removed") f.state.removed = true;
    if (kind === "review") f.state.metadata = { legalworkReviewWorker: true };
    if (kind === "legalmemory") f.state.metadata = { legalworkInternal: "legalmemory" };
    await f.client.session.prompt({ sessionID: "chat", text: "Restricted or unavailable connector" });
    expect(f.state.admissions).toBe(1);
    expect(f.state.connects).toBe(0);
  }
});

test("a foreign session cannot cause connector recovery or prompt admission", async () => {
  const f = await fixture(); f.state.directory = f.outside;
  await expect(f.client.session.prompt({ sessionID: "chat", text: "Wrong project" })).rejects.toThrow();
  expect(f.state.connects).toBe(0); expect(f.state.admissions).toBe(0);
});

test("cancellation prevents model admission while the native handshake settles under its lock", async () => {
  const f = await fixture(), held = Promise.withResolvers<void>(), controller = new AbortController();
  f.state.hold = held.promise;
  const pending = f.client.session.prompt({ sessionID: "chat", text: "Cancel before admission" }, { signal: controller.signal });
  const settled = pending.then(() => "admitted", () => "rejected");
  await waitForNativeFixture(async () => f.state.connects, value => value === 1, "held native handshake");
  controller.abort(new DOMException("Cancelled", "AbortError"));
  expect(await settled).toBe("rejected");
  expect(f.state.admissions).toBe(0);
  expect(f.state.locked).toBe(true);
  held.resolve();
  await waitForNativeFixture(async () => f.state.locked, value => !value, "native handshake cleanup");
  expect(f.state.status).toBe("connected");
});
