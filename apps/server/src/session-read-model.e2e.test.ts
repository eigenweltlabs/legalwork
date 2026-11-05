import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { openSqlite } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function createWorkspaceRoot(folderName?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-session-read-")));
  const workspaceRoot = folderName ? join(root, folderName) : root;
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(root);
  return workspaceRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function startMockOpencode(input: { directory: string; sessionDirectory?: string; invalidList?: boolean; holdCommand?: Promise<void>; idle?: () => boolean; retry?: () => { type: "retry"; attempt: number; message: string; next: number } | null; commands?: () => Array<{ name: string; template: string }>; promptError?: () => { name: string; data: { message: string } } | undefined; providerId?: string; managedCommands?: () => boolean }) {
  const requests: Array<{ pathname: string; search: string; directory: string | null; method: string; body?: unknown }> = [];
  let outcome: string | undefined;
  const messages = () => {
    const retry = input.retry?.();
    return [{ id: "msg_1", type: "assistant", model: { providerID: input.providerId ?? "openai", id: "fixture" }, agent: "legalwork",
      time: { created: 200, ...(retry ? {} : { completed: 201 }) },
      ...(retry ? { retry: { attempt: retry.attempt, at: retry.next, error: { type: "service-unavailable", message: retry.message } } } : {}),
      content: [{ type: "text", text: "hostname: mock-host" }, { type: "tool", id: "call_todos", name: "todowrite", time: { created: 200, ran: 200, completed: 201 }, state: { status: "completed", input: {}, content: [], metadata: { todos: [{ content: "Validate session reads", status: "completed", priority: "high" }] } } }] }];
  };
  const session = () => ({ id: "ses_1", projectID: "project", title: "Hostname Check", location: { directory: input.sessionDirectory ?? input.directory }, time: { created: 100, updated: 200 }, ...(outcome ? { outcome } : {}) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), pathname = url.pathname;
    const received = { pathname, method: request.method, search: url.search, directory: url.searchParams.get("directory") ?? url.searchParams.get("location[directory]"), ...(request.method === "POST" || request.method === "PATCH" ? { body: JSON.parse((await request.text()) || "null") } : {}) };
    requests.push(received);
    if (pathname === "/api/session") return Response.json(input.invalidList ? { data: [{ nope: true }], cursor: {} } : { data: [session()], cursor: {} });
    if (pathname === "/api/session/active") return Response.json({ data: input.idle?.() ? {} : { ses_1: { type: "running" } } });
    if (pathname === "/api/session/ses_1/interrupt") return Response.json({ interrupted: true });
    if (pathname === "/api/rpc/legalwork.commands/cancel") return Response.json({ output: { cancelled: false } });
    if (pathname === "/api/plugin") return Response.json({ data: [{ id: input.managedCommands?.() === false ? "opencode.config.command" : "legalwork.commands", state: { status: "active" } }] });
    if (pathname === "/api/command") return Response.json({ data: (input.commands?.() ?? []).map(({ name }) => ({ name, description: name })) });
    if (pathname === "/api/session/ses_1" && request.method === "GET") return Response.json({ data: session() });
    if (pathname === "/api/session/ses_1" || /^\/api\/session\/ses_1\/(?:model|agent)$/.test(pathname)) return new Response(null, { status: 204 });
    if (pathname === "/api/session/ses_1/inbox") return Response.json({ data: [] });
    if (pathname === "/api/session/ses_1/prompt") {
      const value = received.body;
      const id = value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : "msg_response";
      outcome = input.promptError?.() ? "interrupted" : undefined;
      return Response.json({ data: { id, type: "user", text: value && typeof value === "object" && "text" in value ? value.text : "", time: { created: 202 } } });
    }
    if (pathname === "/api/session/ses_1/message") return Response.json({ data: messages(), cursor: {} });
    if (pathname === "/api/session/ses_1/message/msg_1") return Response.json({ data: messages()[0] });
    if (pathname === "/api/session/ses_1/command") { await input.holdCommand; return new Response(null, { status: 204 }); }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  } });
  stops.push(() => server.stop(true));
  return { server, requests, session };
}

async function startLegalworkServer(input: { workspaceRoot: string; opencodeBaseUrl: string; readOnly?: boolean; agentSandboxEnabled?: boolean }) {
  const config: ServerConfig = {
    configPath: join(input.workspaceRoot, "server.json"),
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.opencodeBaseUrl,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: input.readOnly ?? true,
    agentSandboxEnabled: input.agentSandboxEnabled,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, token: config.token };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await predicate();
}

describe("workspace session read APIs", () => {
  test("persistent retry stops once bounded and its reason survives transcript reload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    let attempt = 2; const retryAt = Date.now() + 60_000;
    const mock = startMockOpencode({ directory: workspaceRoot, retry: () => ({ type: "retry", attempt, message: "Service unavailable", next: retryAt }) });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1`;
    const headers = auth(legalwork.token);
    expect(await fetch(`${base}/retry-stop`, { method: "POST", headers }).then(response => response.json())).toEqual({ stopped: false });
    expect(mock.requests.filter(request => request.pathname.endsWith("/interrupt"))).toHaveLength(0);
    attempt = 3;
    expect(await fetch(`${base}/retry-stop`, { method: "POST", headers }).then(response => response.json())).toEqual({ stopped: true });
    expect(mock.requests.filter(request => request.pathname.endsWith("/interrupt"))).toHaveLength(1);
    const snapshot = await fetch(`${base}/snapshot`, { headers }).then(response => response.json());
    expect(snapshot.item.messages[0].error.message).toContain("Automatic retries stopped");
    const messages = await fetch(`${base}/messages`, { headers }).then(response => response.json());
    expect(messages.items[0].error.message).toBe(snapshot.item.messages[0].error.message);
  });

  test("request admission details survive snapshot and transcript reads, and malformed details are rejected", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    // Start with the provider-only table shipped before admission details.
    const db = await openSqlite(join(workspaceRoot, "runtime.sqlite"));
    db.exec("CREATE TABLE session_usage_limits (workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, provider_id TEXT NOT NULL, PRIMARY KEY(workspace_id,session_id,message_id))");
    db.run("INSERT INTO session_usage_limits VALUES (?,?,?,?)", ["ws_1", "ses_1", "msg_1", "openai"]);
    const mock = startMockOpencode({ directory: workspaceRoot, providerId: "eigenwelt" });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1`;
    const headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const legacy = await fetch(`${base}/snapshot`, { headers }).then(response => response.json());
    expect(legacy.item.messages[0].error.message).toBe("LegalWork provider usage limit: openai");
    const limit = { reason: "organization_limit", requiredMicros: 200000, availableMicros: 90000 };
    const response = await fetch(`${base}/usage-limit`, { method: "POST", headers, body: JSON.stringify({ messageId: "msg_1", limit }) });
    expect(response.status).toBe(200);
    const snapshot = await fetch(`${base}/snapshot`, { headers }).then(response => response.json());
    const text = snapshot.item.messages[0].error.message;
    expect(decodeURIComponent(text.split(" ").at(-1))).toBe(JSON.stringify(limit));
    const messages = await fetch(`${base}/messages`, { headers }).then(response => response.json());
    expect(messages.items[0].error.message).toBe(text);
    const malformed = await fetch(`${base}/usage-limit`, { method: "POST", headers, body: JSON.stringify({ messageId: "msg_1", limit: { ...limit, reason: "unknown" } }) });
    expect(malformed.status).toBe(400);
  });
  test("a stopped quota turn stays actionable in subsequent snapshots and message reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1`;
    const response = await fetch(`${base}/usage-limit`, { method: "POST", headers: { ...auth(legalwork.token), "Content-Type": "application/json" }, body: JSON.stringify({ messageId: "msg_1" }) });
    expect(response.status).toBe(200);
    const snapshot = await fetch(`${base}/snapshot`, { headers: auth(legalwork.token) }).then(response => response.json());
    expect(snapshot.item.messages[0].error.message).toBe("LegalWork provider usage limit: openai");
    const messages = await fetch(`${base}/messages`, { headers: auth(legalwork.token) }).then(response => response.json());
    expect(messages.items[0].error).toEqual(snapshot.item.messages[0].error);
    const wrongTurn = await fetch(`${base}/usage-limit`, { method: "POST", headers: { ...auth(legalwork.token), "Content-Type": "application/json" }, body: JSON.stringify({ messageId: "does-not-exist" }) });
    expect(wrongTurn.status).not.toBe(200);
  });

  test("lists sessions and returns session details, messages, and snapshot", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const base = `http://127.0.0.1:${legalwork.server.port}`;

    const listResponse = await fetch(`${base}/workspace/ws_1/sessions?roots=true&limit=1&search=host&start=10`, {
      headers: auth(legalwork.token),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody).toEqual({ items: [mock.session()] });

    const detailResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1`, {
      headers: auth(legalwork.token),
    });
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.item.id).toBe("ses_1");
    expect(detailBody.item.location.directory).toBe(workspaceRoot);

    const messagesResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/messages?limit=5`, {
      headers: auth(legalwork.token),
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json();
    expect(messagesBody.items).toHaveLength(1);
    expect(messagesBody.items[0]?.id).toBe("msg_1");
    expect(messagesBody.items[0]?.content[0]?.text).toBe("hostname: mock-host");

    const snapshotResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/snapshot?limit=5`, {
      headers: auth(legalwork.token),
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = await snapshotResponse.json();
    expect(snapshotBody.item.session.id).toBe("ses_1");
    expect(snapshotBody.item.messages).toHaveLength(1);
    expect(snapshotBody.item.todos).toEqual([
      {
        content: "Validate session reads",
        status: "completed",
        priority: "high",
      },
    ]);
    expect(snapshotBody.item.status).toEqual({ type: "busy" });

    const listRequest = mock.requests.find((request) => request.pathname === "/api/session");
    expect(listRequest?.directory).toBe(workspaceRoot);
    expect(listRequest?.search).toContain("parentID=null");
    // Fetch every native page before applying the legacy start filter and UI limit.
    expect(listRequest?.search).not.toContain("limit=");
    expect(listRequest?.search).toContain("search=host");
    // Legacy start filtering is applied by LegalWork after native pagination.
    expect(listRequest?.search).not.toContain("start=");

  });

  test("accepts historical rem_ aliases for local-project session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/rem_ws_1/sessions`, {
      headers: auth(legalwork.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]?.id).toBe("ses_1");
    expect(body.items[0]?.location.directory).toBe(workspaceRoot);
    expect(mock.requests.find((request) => request.pathname === "/api/session")?.directory).toBe(workspaceRoot);
  });

  test("encodes non-ASCII workspace directory queries for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(legalwork.token),
    });

    expect(response.status).toBe(200);
    const listRequest = mock.requests.find((request) => request.pathname === "/api/session");
    const encodedDirectory = encodeURIComponent(workspaceRoot);
    expect(listRequest?.directory).toBe(workspaceRoot);
    expect(listRequest?.search).toContain(`directory=${encodedDirectory}`);
  });

  test("encodes non-ASCII workspace directory queries for native proxy requests", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/opencode/api/session`, {
      headers: auth(legalwork.token),
    });

    expect(response.status).toBe(200);
    const proxyRequest = mock.requests.find((request) => request.pathname === "/api/session");
    expect(proxyRequest?.directory).toBe(workspaceRoot);
  });

  test("returns 404 when the upstream session is missing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_missing/snapshot`, {
      headers: auth(legalwork.token),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_request_failed",
    });

  });

  test("acknowledges server-staged native commands before engine execution completes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const command = deferred();
    const mock = startMockOpencode({ directory: workspaceRoot, holdCommand: command.promise, idle: () => true });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false,
    });

    const response = await Promise.race([
      fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/dispatch`, {
        method: "POST",
        headers: { ...auth(legalwork.token), "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "command", command: "review", args: "" }),
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(response).not.toBe("timeout");
    expect(response instanceof Response ? response.status : 0).toBe(200);
    await expect(response instanceof Response ? response.json() : null).resolves.toMatchObject({ accepted: true });
    const sawCommand = await waitUntil(() => mock.requests.some((request) => request.pathname === "/api/session/ses_1/command"));
    command.resolve();
    expect(sawCommand).toBe(true);
  });

  test("keeps legacy /w workspace opencode proxy alias", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/w/ws_1/opencode/api/session`, {
      headers: auth(legalwork.token),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(mock.requests.some((request) => request.pathname === "/api/session")).toBe(true);
  });

  test("forwards sandbox-rewritten native permissions without a stale content length", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false, agentSandboxEnabled: true });
    const originalFetch = globalThis.fetch;
    let forwarded: { headers: Headers; body: unknown } | undefined;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/session/ses_1" && init?.method === "PATCH") {
        if (!(init.body instanceof ArrayBuffer)) throw new Error("expected buffered proxy body");
        forwarded = { headers: new Headers(init.headers), body: JSON.parse(Buffer.from(init.body).toString()) };
        return new Response(null, { status: 204 });
      }
      return originalFetch(input, init);
    }, originalFetch);
    stops.push(() => { globalThis.fetch = originalFetch; });
    const body = JSON.stringify({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] });
    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/opencode/api/session/ses_1`, {
      method: "PATCH", headers: { ...auth(legalwork.token), "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }, body,
    });
    expect(response.status).toBe(204);
    expect(forwarded?.body).toMatchObject({ permissions: expect.arrayContaining([{ action: "legalwork_shell", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "deny" }]) });
    expect(forwarded?.headers.get("content-length")).toBeNull();
  });

  test("returns 502 when OpenCode returns an invalid session list payload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot, invalidList: true });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(legalwork.token),
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_invalid_response",
      message: "OpenCode returned invalid session list",
    });

  });

  test("reports an unreachable OpenCode engine as unavailable", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    await probe.stop(true);
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(legalwork.token),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_unavailable",
      message: "The agent engine could not be reached. Start it or reconnect before trying again.",
    });
  });
});


describe("shared session queue API", () => {
  test("queued commands preserve executable arguments only through the active managed integration; direct host shell stays denied", async () => {
    const workspaceRoot = await createWorkspaceRoot(); let integrated = true;
    const mock = startMockOpencode({ directory: workspaceRoot, idle: () => true, managedCommands: () => integrated, commands: () => [{ name: "review", template: "Review" }, { name: "unsafe", template: "Inspect !`echo sandboxed`" }] });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false, agentSandboxEnabled: true });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`, headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const enqueue = (execution: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify({ type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "queue check", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution }) });
    expect((await enqueue({ kind: "shell", command: "echo forbidden-host-execution" })).status).toBe(403);
    expect((await fetch(base, { headers }).then(response => response.json())).entries).toEqual([]);
    const command = { kind: "command", command: "unsafe", args: "!`echo permission-scoped-expansion`", model: { providerID: "test", id: "test" } };
    expect((await enqueue(command)).status).toBe(200);
    expect(await waitUntil(() => mock.requests.some(request => request.pathname === "/api/session/ses_1/command"))).toBe(true);
    expect(mock.requests.find(request => request.pathname === "/api/session/ses_1/command")?.body).toMatchObject({ name: "unsafe", text: command.args });
    expect(mock.requests.some(request => request.pathname.endsWith("/shell"))).toBe(false);
    integrated = false;
    const before = (await fetch(base, { headers }).then(response => response.json())).entries.map((entry: {id:string}) => entry.id);
    expect((await enqueue({ ...command, command: "review" })).status).toBe(503);
    expect((await fetch(base, { headers }).then(response => response.json())).entries.map((entry: {id:string}) => entry.id)).toEqual(before);
  });
  test("a queued shortcut is checked again when its definition is removed before dispatch", async () => {
    const workspaceRoot = await createWorkspaceRoot(); let available = true;
    const mock = startMockOpencode({ directory: workspaceRoot, idle: () => true, commands: () => available ? [{ name: "review", template: "Review these files" }] : [] });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false, agentSandboxEnabled: true });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`, headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const send = (action: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(action) }), read = () => fetch(base, { headers }).then(response => response.json());
    expect((await send({ type: "pause", paused: true })).status).toBe(200);
    expect((await send({ type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "queue check", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "command", command: "review", args: "", model: { providerID: "test", id: "test" } } })).status).toBe(200);
    available = false; expect((await send({ type: "pause", paused: false })).status).toBe(200);
    expect(await waitUntil(async () => (await read()).entries[0]?.status === "failed")).toBe(true);
    const queue = await read(); expect(queue.paused).toBe(true); expect(queue.entries[0].error).toContain("Command not found");
    expect(mock.requests.some(request => request.pathname === "/api/session/ses_1/command")).toBe(false);
  });
  test("a globally visible chat from another project cannot be read or changed through this project's queue", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const otherRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot, sessionDirectory: otherRoot });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`;
    const headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    for (const url of [base, `${base}?revision=0`]) expect((await fetch(url, { headers })).status).toBe(404);
    for (const action of [
      { type: "pause", paused: true },
      { type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "wrong project", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "shell", command: "echo wrong" } },
    ]) expect((await fetch(base, { method: "POST", headers, body: JSON.stringify(action) })).status).toBe(404);
    expect(mock.requests.some(request => request.method === "POST" || request.method === "PATCH")).toBe(false);
  });
  test("a confirmed aborted prompt completes delivery and follow-ups can resume without resending it", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    let aborted = true;
    const mock = startMockOpencode({ directory: workspaceRoot, idle: () => true, promptError: () => aborted ? { name: "MessageAbortedError", data: { message: "Stopped by user" } } : undefined });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`;
    const headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const send = (body: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
    const read = () => fetch(base, { headers }).then(r => r.json());
    const first = { type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "first", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "prompt", model: { providerID: "test", id: "test" }, text: "first" } };
    const second = { ...first, id: crypto.randomUUID() };
    await send({ type: "pause", paused: true });
    await send(first); await send(second);
    await send({ type: "pause", paused: false });
    for (let attempt = 0; attempt < 100 && !(await read()).paused; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const stopped = await read();
    expect(stopped.paused).toBe(true);
    expect(stopped.completedIds).toContain(first.id);
    expect(stopped.entries.map((entry: { id: string; status: string }) => [entry.id, entry.status])).toEqual([[second.id, "queued"]]);
    aborted = false;
    expect((await send({ type: "pause", paused: false })).status).toBe(200);
    for (let attempt = 0; attempt < 100 && (await read()).entries.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await read()).entries).toEqual([]);
    await send(first); // An acknowledgement retry cannot resend the aborted original.
    expect(mock.requests.filter(request => request.pathname === "/api/session/ses_1/prompt" && request.method === "POST")).toHaveLength(2);
  });
  test("both windows read the same queue; server dispatch restores the chat once and rejects stale writes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    let idle = false;
    const mock = startMockOpencode({ directory: workspaceRoot, idle: () => idle });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`;
    const headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const send = (body: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
    const input = { type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "synthetic queue check", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "prompt", model: { providerID: "test", id: "test" }, text: "synthetic queue check" } };
    expect((await send(input)).status).toBe(200);
    const readA = await fetch(base, { headers }).then(r => r.json());
    const readB = await fetch(base, { headers }).then(r => r.json());
    expect(readA).toEqual(readB);
    expect(readB.entries[0].draft.text).toBe(input.draft.text);
    expect(await fetch(`${base}?revision=${readB.revision}`, { headers }).then(r => r.json())).toBeNull();
    expect((await send({ type: "remove", id: input.id, revision: 0 })).status).toBe(409);
    idle = true;
    expect((await send({ type: "pause", paused: false })).status).toBe(200);
    expect(await waitUntil(() => mock.requests.some(r => r.pathname === "/api/session/ses_1/prompt"))).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await send(input)).status).toBe(200);
    expect(mock.requests.filter(r => r.pathname === "/api/session/ses_1/prompt")).toHaveLength(1);
    const restoreIndex = mock.requests.findIndex(r => r.pathname === "/api/session/ses_1" && r.method === "PATCH");
    const sendIndex = mock.requests.findIndex(r => r.pathname === "/api/session/ses_1/prompt" && r.method === "POST");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeLessThan(sendIndex);
    expect(await waitUntil(async () => (await fetch(base, { headers }).then(r => r.json())).entries.length === 0)).toBe(true);
    const unknown = await fetch(base.replace("ses_1", "ses_missing"), { method: "POST", headers, body: JSON.stringify(input) });
    expect(unknown.ok).toBe(false);
    expect((await fetch(base)).status).toBe(401);
  });
  test("read-only servers never accept executable queue changes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ directory: workspaceRoot });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}` });
    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`, { method: "POST", headers: { ...auth(legalwork.token), "Content-Type": "application/json" }, body: JSON.stringify({ type: "pause", paused: false }) });
    expect(response.status).toBe(403);
  });
});
