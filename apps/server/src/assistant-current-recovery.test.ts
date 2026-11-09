import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assistantEngineClient } from "./assistant-engine.js";
import { createEngineClient } from "./engine-client.js";
import { MainAssistant } from "./main-assistant.js";
import { commitRegisteredEngineProjects } from "./project-engine-registration.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-recovery-"));
  let created = false, creations = 0, listings = 0;
  let delayList = false, loseCreateReply = false;
  const session = { id: "daily-chat", title: "2026-11-07", projectID: "project", location: { directory: root },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } };
  const engine = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session" && request.method === "GET") {
      listings++;
      if (delayList || url.searchParams.has("cursor")) await Bun.sleep(150);
      return Response.json({ data: created ? [session] : [], cursor: { next: url.searchParams.get("search") === "paged" && !url.searchParams.has("cursor") ? "page-2" : null, previous: null } });
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      created = true; creations++;
      if (loseCreateReply) { loseCreateReply = false; await Bun.sleep(150); }
      return Response.json({ data: session });
    }
    if (url.pathname === "/api/session/daily-chat") return created ? Response.json({ data: session }) : new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  } });
  const workspace: WorkspaceInfo = { id: "assistant", path: root, name: "Assistant", preset: "main-assistant", workspaceType: "local" };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "server.json"),
    opencodeBaseUrl: engine.url.origin, workspaces: [workspace], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const client = assistantEngineClient(createEngineClient(config, workspace), root);
  const assistant = await MainAssistant.open(config, join(root, "runtime.sqlite"), () => ({
    get: async id => {
      const result = await client.session.get({ sessionID: id }, { signal: AbortSignal.timeout(50), throwOnError: true });
      if (!result.data) throw new Error("Missing session");
      return result.data;
    },
    list: async () => {
      const result = await client.session.list({}, { signal: AbortSignal.timeout(50), throwOnError: true });
      if (!result.data) throw new Error("Missing sessions");
      return result.data;
    },
    create: async title => {
      const result = await client.session.create({ title }, { signal: AbortSignal.timeout(50), throwOnError: true });
      if (!result.data) throw new Error("Missing session");
      return result.data;
    },
  }), undefined, () => new Date(2026, 10, 7, 12));
  return { root, config, client, assistant, native: OpenCode.make({ baseUrl: engine.url.origin }),
    delayList: () => { delayList = true; }, resume: () => { delayList = false; }, loseCreateReply: () => { loseCreateReply = true; },
    counts: () => ({ listings, creations }), close: async () => { engine.stop(true); await rm(root, { recursive: true, force: true }); } };
}

test("Assistant cancels stalled listing, releases shared initialization and recovers exactly once", async () => {
  const f = await fixture();
  try {
    f.delayList();
    const first = f.assistant.current(), joined = f.assistant.current();
    expect(first).toBe(joined);
    const outcomes = await Promise.allSettled([first, joined]);
    expect(outcomes.every(result => result.status === "rejected")).toBe(true);
    expect(f.assistant.savedDay()).toBeNull();
    expect(f.counts()).toEqual({ listings: 1, creations: 0 });
    f.resume();
    const current = await f.assistant.current();
    expect(current.day.sessionId).toBe("daily-chat");
    expect(await f.assistant.current()).toEqual(current);
    expect(f.counts()).toEqual({ listings: 2, creations: 1 });
  } finally { await f.close(); }
});

test("Assistant recovers a committed session after its create reply times out", async () => {
  const f = await fixture();
  try {
    f.loseCreateReply();
    await expect(f.assistant.current()).rejects.toThrow();
    expect(f.assistant.savedDay()).toBeNull();
    expect((await f.assistant.current()).day.sessionId).toBe("daily-chat");
    expect(f.counts()).toEqual({ listings: 2, creations: 1 });
  } finally { await f.close(); }
});

test("session list and children carry one deadline across pagination", async () => {
  const f = await fixture();
  try {
    const client = assistantEngineClient(f.native, f.root);
    await expect(client.session.list({ search: "paged" }, { signal: AbortSignal.timeout(50), throwOnError: true })).rejects.toThrow();
    expect(f.counts().listings).toBe(2);
    f.delayList();
    await expect(client.session.children({ sessionID: "parent" }, { signal: AbortSignal.timeout(50), throwOnError: true })).rejects.toThrow();
    expect(f.counts().listings).toBe(3);
  } finally { await f.close(); }
});

test("a caller deadline stops waiting for publication without cancelling other callers", async () => {
  const f = await fixture();
  // Use the same registration object for both publication and client admission.
  const config = { ...f.config, opencodeBaseUrl: undefined };
  let finish = () => {};
  const active = commitRegisteredEngineProjects(config, () => new Promise<void>(resolve => { finish = resolve; }));
  const workspace = { ...config.workspaces[0], baseUrl: f.config.opencodeBaseUrl };
  const client = assistantEngineClient(createEngineClient(config, workspace), f.root);
  try {
    await expect(client.session.list({}, { signal: AbortSignal.timeout(50), throwOnError: true })).rejects.toThrow();
    expect(f.counts().listings).toBe(0);
    finish(); await active;
    expect((await client.session.list({}, { signal: AbortSignal.timeout(1000), throwOnError: true })).data).toEqual([]);
    expect(f.counts().listings).toBe(1);
  } finally { finish(); await active; await f.close(); }
});
