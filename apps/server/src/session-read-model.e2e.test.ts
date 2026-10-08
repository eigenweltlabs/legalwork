import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
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
  const root = await mkdtemp(join(tmpdir(), "legalwork-session-read-"));
  const workspaceRoot = folderName ? join(root, folderName) : root;
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(root);
  return workspaceRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function startMockOpencode(input?: { invalidList?: boolean; holdCommand?: Promise<void>; idle?: () => boolean; promptError?: () => { name: string; data: { message: string } } | undefined }) {
  const requests: Array<{ pathname: string; search: string; directory: string | null; method: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        pathname: url.pathname,
        method: request.method,
        search: url.search,
        directory: request.headers.get("x-opencode-directory"),
      });

      if (url.pathname === "/session") {
        if (input?.invalidList) {
          return Response.json({ nope: true });
        }
        return Response.json([
          {
            id: "ses_1",
            title: "Hostname Check",
            slug: "hostname-check",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 100, updated: 200 },
          },
        ]);
      }

      if (url.pathname === "/session/status") {
        return Response.json({ ses_1: { type: input?.idle?.() ? "idle" : "busy" } });
      }

      if (url.pathname === "/session/ses_1") {
        return Response.json({
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: request.headers.get("x-opencode-directory"),
          time: { created: 100, updated: 200 },
        });
      }

      if (url.pathname === "/session/ses_1/message" && request.method === "POST") {
        return Response.json({ info: { id: "response", role: "assistant", error: input?.promptError?.() }, parts: [] });
      }

      if (url.pathname === "/session/ses_1/message") {
        return Response.json([
          {
            info: {
              id: "msg_1",
              sessionID: "ses_1",
              role: "assistant",
              time: { created: 200 },
            },
            parts: [
              {
                id: "prt_1",
                messageID: "msg_1",
                sessionID: "ses_1",
                type: "text",
                text: "hostname: mock-host",
              },
            ],
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/message/msg_1") {
        return Response.json({ info: { id: "msg_1", sessionID: "ses_1", role: "assistant", providerID: "openai" }, parts: [] });
      }

      if (url.pathname === "/session/ses_1/todo") {
        return Response.json([
          {
            content: "Validate session reads",
            status: "completed",
            priority: "high",
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/command" && request.method === "POST") {
        await input?.holdCommand;
        return Response.json({ ok: true });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startLegalworkServer(input: { workspaceRoot: string; opencodeBaseUrl: string; readOnly?: boolean }) {
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

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("workspace session read APIs", () => {
  test("a stopped quota turn stays actionable in subsequent snapshots and message reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1`;
    const response = await fetch(`${base}/usage-limit`, { method: "POST", headers: { ...auth(legalwork.token), "Content-Type": "application/json" }, body: JSON.stringify({ messageId: "msg_1" }) });
    expect(response.status).toBe(200);
    const snapshot = await fetch(`${base}/snapshot`, { headers: auth(legalwork.token) }).then(response => response.json());
    expect(snapshot.item.messages[0].info.error.data.message).toBe("LegalWork provider usage limit: openai");
    const messages = await fetch(`${base}/messages`, { headers: auth(legalwork.token) }).then(response => response.json());
    expect(messages.items[0].info.error).toEqual(snapshot.item.messages[0].info.error);
    const wrongTurn = await fetch(`${base}/usage-limit`, { method: "POST", headers: { ...auth(legalwork.token), "Content-Type": "application/json" }, body: JSON.stringify({ messageId: "does-not-exist" }) });
    expect(wrongTurn.status).not.toBe(200);
  });

  test("lists sessions and returns session details, messages, and snapshot", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
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
    expect(listBody).toEqual({
      items: [
        {
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: workspaceRoot,
          time: { created: 100, updated: 200 },
        },
      ],
    });

    const detailResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1`, {
      headers: auth(legalwork.token),
    });
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.item.id).toBe("ses_1");
    expect(detailBody.item.directory).toBe(workspaceRoot);

    const messagesResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/messages?limit=5`, {
      headers: auth(legalwork.token),
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json();
    expect(messagesBody.items).toHaveLength(1);
    expect(messagesBody.items[0]?.info.id).toBe("msg_1");
    expect(messagesBody.items[0]?.parts[0]?.text).toBe("hostname: mock-host");

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

    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(listRequest?.directory).toBe(workspaceRoot);
    expect(listRequest?.search).toContain("roots=true");
    expect(listRequest?.search).toContain("limit=1");
    expect(listRequest?.search).toContain("search=host");
    expect(listRequest?.search).toContain("start=10");

  });

  test("accepts guest-side rem_ workspace aliases for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
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
    expect(body.items[0]?.directory).toBe(workspaceRoot);
    expect(mock.requests.find((request) => request.pathname === "/session")?.directory).toBe(workspaceRoot);
  });

  test("encodes non-ASCII workspace directory headers for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(legalwork.token),
    });

    expect(response.status).toBe(200);
    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    const encodedDirectory = encodeURIComponent(workspaceRoot);
    expect(listRequest?.directory).toBe(encodedDirectory);
    expect(listRequest?.search).toContain(`directory=${encodedDirectory}`);
  });

  test("encodes non-ASCII workspace directory headers for opencode proxy requests", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/opencode/session`, {
      headers: auth(legalwork.token),
    });

    expect(response.status).toBe(200);
    const proxyRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(proxyRequest?.directory).toBe(encodeURIComponent(workspaceRoot));
  });

  test("returns 404 when the upstream session is missing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_missing/snapshot`, {
      headers: auth(legalwork.token),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_not_found",
      message: "Session not found",
    });

  });

  test("acknowledges proxied session commands before upstream completion", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const command = deferred();
    const mock = startMockOpencode({ holdCommand: command.promise });
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await Promise.race([
      fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/opencode/session/ses_1/command`, {
        method: "POST",
        headers: { ...auth(legalwork.token), "Content-Type": "application/json" },
        body: JSON.stringify({ command: "review", arguments: "" }),
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(response).not.toBe("timeout");
    expect(response instanceof Response ? response.status : 0).toBe(200);
    await expect(response instanceof Response ? response.json() : null).resolves.toMatchObject({ accepted: true });
    const sawCommand = await waitUntil(() => mock.requests.some((request) => request.pathname === "/session/ses_1/command"));
    command.resolve();
    expect(sawCommand).toBe(true);
  });

  test("keeps legacy /w workspace opencode proxy alias", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/w/ws_1/opencode/session`, {
      headers: auth(legalwork.token),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(mock.requests.some((request) => request.pathname === "/session")).toBe(true);
  });

  test("returns 502 when OpenCode returns an invalid session list payload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ invalidList: true });
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
      message: "OpenCode engine is not ready",
    });
  });
});


describe("shared session queue API", () => {
  test("a confirmed aborted prompt completes delivery and follow-ups can resume without resending it", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    let aborted = true;
    const mock = startMockOpencode({ idle: () => true, promptError: () => aborted ? { name: "MessageAbortedError", data: { message: "Stopped by user" } } : undefined });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`;
    const headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const send = (body: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
    const read = () => fetch(base, { headers }).then(r => r.json());
    const first = { type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "first", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "prompt", model: { providerID: "test", modelID: "test" }, parts: [{ type: "text", text: "first" }] } };
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
    expect(mock.requests.filter(request => request.pathname === "/session/ses_1/message" && request.method === "POST")).toHaveLength(2);
  });
  test("both windows read the same queue; server dispatch restores the chat once and rejects stale writes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    let idle = false;
    const mock = startMockOpencode({ idle: () => idle });
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
    const base = `http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`;
    const headers = { ...auth(legalwork.token), "Content-Type": "application/json" };
    const send = (body: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
    const input = { type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text: "synthetic queue check", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "prompt", model: { providerID: "test", modelID: "test" }, parts: [{ type: "text", text: "synthetic queue check" }] } };
    expect((await send(input)).status).toBe(200);
    const readA = await fetch(base, { headers }).then(r => r.json());
    const readB = await fetch(base, { headers }).then(r => r.json());
    expect(readA).toEqual(readB);
    expect(readB.entries[0].draft.text).toBe(input.draft.text);
    expect(await fetch(`${base}?revision=${readB.revision}`, { headers }).then(r => r.json())).toBeNull();
    expect((await send({ type: "remove", id: input.id, revision: 0 })).status).toBe(409);
    idle = true;
    expect((await send({ type: "pause", paused: false })).status).toBe(200);
    expect(await waitUntil(() => mock.requests.some(r => r.pathname === "/session/ses_1/message"))).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await send(input)).status).toBe(200);
    expect(mock.requests.filter(r => r.pathname === "/session/ses_1/message")).toHaveLength(1);
    const restoreIndex = mock.requests.findIndex(r => r.pathname === "/session/ses_1" && r.method === "PATCH");
    const sendIndex = mock.requests.findIndex(r => r.pathname === "/session/ses_1/message" && r.method === "POST");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeLessThan(sendIndex);
    const final = await fetch(base, { headers }).then(r => r.json());
    expect(final.entries).toEqual([]);
    const unknown = await fetch(base.replace("ses_1", "ses_missing"), { method: "POST", headers, body: JSON.stringify(input) });
    expect(unknown.ok).toBe(false);
    expect((await fetch(base)).status).toBe(401);
  });
  test("read-only servers never accept executable queue changes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const legalwork = await startLegalworkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}` });
    const response = await fetch(`http://127.0.0.1:${legalwork.server.port}/workspace/ws_1/sessions/ses_1/queue`, { method: "POST", headers: { ...auth(legalwork.token), "Content-Type": "application/json" }, body: JSON.stringify({ type: "pause", paused: false }) });
    expect(response.status).toBe(403);
  });
});
