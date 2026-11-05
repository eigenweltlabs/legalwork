import { afterEach, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ViewRecordSchema, type ViewPreview } from "@legalwork/types/views";
import { withSessionExecution } from "./session-execution-gate.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-view-delete-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const preview: ViewPreview = { status: "preview", owner: { kind: "workspace", id: "project" }, input: { version: 1, title: "Unsaved dashboard", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Keep this")', queries: {} } };
  const state: { deleted: number; busy: boolean; child: boolean; childBusy: boolean; calls: string[]; runningAtRead: boolean; recovery: boolean; syntheticFailure: boolean; recoveryInput?: unknown; prompts: number; reviewHook?: () => Promise<void> } = { deleted: 0, busy: false, child: false, childBusy: false, calls: ["call1"], runningAtRead: false, recovery: false, syntheticFailure: false, prompts: 0 };
  const session = (id: string) => ({ id, projectID: "project", location: { directory: root }, ...(id === "child" ? { parentID: "chat" } : {}), title: "Chat", time: { created: 1, updated: 1 } });
  const tool = (id: string, name: string, status: string, text: string, metadata = {}) => ({ type: "tool", id, name, time: { created: 2, ran: 2, ...(status === "completed" ? { completed: 3 } : {}) }, state: { status, input: {}, content: [{ type: "text", text }], metadata } });
  const assistant = (id: string, content: unknown[], created = 2) => ({ id, type: "assistant", agent: "legalwork", model: { providerID: "test", id: "test" }, time: { created, completed: created + 1 }, content });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/api/session/active") return Response.json({ data: { ...(state.busy ? { chat: { type: "running" } } : {}), ...(state.childBusy ? { child: { type: "running" } } : {}) } });
    if (path === "/api/session") return Response.json({ data: url.searchParams.get("parentID") === "chat" && state.child ? [session("child")] : [], cursor: {} });
    if (path === "/api/session/chat" && request.method === "DELETE") { state.deleted++; return new Response(null, { status: 204 }); }
    if (/^\/api\/session\/(?:chat|child|unrelated)$/.test(path)) return Response.json({ data: session(path.split("/").at(-1)!) });
    if (path === "/api/session/chat/inbox") return Response.json({ data: [] });
    if (path === "/api/session/chat/synthetic") { state.recoveryInput = await request.json(); if (state.syntheticFailure) { state.syntheticFailure = false; return Response.json({ message: "Fixture engine temporarily unavailable before admission" }, { status: 503 }); } state.prompts++; return Response.json({ data: { id: "recovery", type: "synthetic", text: "Recovery admitted", time: { created: 10 } } }); }
    if (path === "/api/session/unrelated/prompt") return Response.json({ data: { id: "new", type: "user", text: "Unrelated", time: { created: 10 } } });
    if (path === "/api/session/child/message") return Response.json({ data: [assistant("child-msg", [tool("child-call", "view_create", "completed", JSON.stringify(preview))])], cursor: {} });
    if (path === "/api/session/chat/message" && state.recovery) return Response.json({ data: [
      { id: "human", type: "user", text: "Finish my review", time: { created: 1 } },
      assistant("review", [tool("review-call", "legalwork_review_get", "completed", "Review exists"), tool("todo", "todowrite", "completed", "", { todos: [{ content: "Finish review", status: "in_progress", priority: "high" }] })], 2),
      { ...assistant("empty", [{ type: "reasoning", text: "Thinking" }], 4), finish: "stop" },
    ].sort((a,b) => url.searchParams.get("order") === "desc" ? b.time.created-a.time.created : a.time.created-b.time.created), cursor: {} });
    if (path === "/api/session/chat/message") { if (state.reviewHook) await state.reviewHook(); return Response.json({ data: [assistant("msg", state.calls.map(callID => tool(callID, "view_create", state.runningAtRead ? "running" : "completed", "Preview ready", { legalworkViewPreview: preview })))], cursor: {} }); }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  } });
  cleanup.push(() => { engine.stop(true); });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [{ id: "project", name: "Project", path: root, workspaceType: "local", preset: "starter", baseUrl: `http://127.0.0.1:${engine.port}` }], authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const server = await startServer(config); cleanup.push(() => server.stop());
  const request = (path: string, method = "GET", body?: unknown, source?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}${source ? `?source=${encodeURIComponent(JSON.stringify(source))}` : ""}`, { method, headers: { authorization: "Bearer test", "x-legalwork-host-token": "host", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { root, state, request, preview, config };
}
const reviewSchema = z.object({ items: z.array(z.object({ callId: z.string() })), reviewToken: z.string() });
const endpoint = "/workspace/project/sessions/chat";
test("deletion requires a reviewed discard and invalidates stale confirmations", async () => {
  const { state, request } = await fixture();
  expect((await request(endpoint, "DELETE")).status).toBe(409);
  const review = reviewSchema.parse(await (await request(`${endpoint}/views`)).json());
  expect(review.items).toEqual([{ callId: "call1" }]);
  state.calls.push("call2");
  expect((await request(`${endpoint}?discardReview=${review.reviewToken}`, "DELETE")).status).toBe(409);
  expect(state.deleted).toBe(0);
  const current = reviewSchema.parse(await (await request(`${endpoint}/views`)).json());
  expect((await request(`${endpoint}?discardReview=${current.reviewToken}`, "DELETE")).status).toBe(200);
  expect(state.deleted).toBe(1);
});
test("saved copies survive chat deletion; removing a copy restores the warning", async () => {
  const { root, state, request, preview } = await fixture();
  const response = await request("/workspace/project/ui-views", "POST", preview.input, { workspaceId: "project", sessionId: "chat", callId: "call1" });
  expect(response.status).toBe(201);
  const view = ViewRecordSchema.parse(await response.json());
  expect(reviewSchema.parse(await (await request(`${endpoint}/views`)).json()).items).toHaveLength(0);
  await rm(join(root, "Dashboards", `${view.id}.view.json`));
  expect((await request(endpoint, "DELETE")).status).toBe(409);
  expect(state.deleted).toBe(0);
  const again = await request("/workspace/project/ui-views", "POST", preview.input);
  const copy = ViewRecordSchema.parse(await again.json());
  expect((await request(endpoint, "DELETE")).status).toBe(200);
  expect((await request(`/workspace/project/ui-views/${copy.id}`)).status).toBe(200);
});
test("active generation and direct proxy deletion cannot bypass dashboard review", async () => {
  const { state, request } = await fixture();
  const review = reviewSchema.parse(await (await request(`${endpoint}/views`)).json());
  state.busy = true;
  expect((await request(`${endpoint}?discardReview=${review.reviewToken}`, "DELETE")).status).toBe(409);
  expect((await request("/workspace/project/opencode/api/session/chat", "DELETE")).status).toBe(409);
  expect(state.deleted).toBe(0);
});


test("parent deletion also protects dashboards and running generation in child chats", async () => {
  const { state, request, preview } = await fixture();
  state.calls = []; state.child = true;
  expect((await request(endpoint, "DELETE")).status).toBe(409);
  const childReview = z.object({ items: z.array(z.object({ sessionId: z.string(), callId: z.string() })), reviewToken: z.string() }).parse(await (await request(`${endpoint}/views`)).json());
  expect(childReview.items).toEqual([{ sessionId: "child", callId: "child-call" }]);
  state.childBusy = true;
  expect((await request(`${endpoint}?discardReview=${childReview.reviewToken}`, "DELETE")).status).toBe(409);
  state.childBusy = false;
  expect((await request("/workspace/project/ui-views", "POST", preview.input, { workspaceId: "project", sessionId: "child", callId: "child-call" })).status).toBe(201);
  expect((await request(endpoint, "DELETE")).status).toBe(200);
  expect(state.deleted).toBe(1);
});

test("running tools cannot disappear between transcript review and the idle check", async () => {
  const { state, request } = await fixture();
  state.runningAtRead = true;
  // Engine status has already become idle, but its transcript snapshot is lagging.
  const response = await request(endpoint, "DELETE");
  expect(response.status).toBe(409);
  expect(state.deleted).toBe(0);
  state.runningAtRead = false;
  const review = reviewSchema.parse(await (await request(`${endpoint}/views`)).json());
  expect(review.items).toHaveLength(1);
  expect((await request(`${endpoint}?discardReview=${review.reviewToken}`, "DELETE")).status).toBe(200);
});

test("deletion excludes direct sends, queue mutations, and another delete until review finishes", async () => {
  const { state, request } = await fixture();
  let reviewed = () => {}, release = () => {};
  const reached = new Promise<void>(resolve => { reviewed = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  state.reviewHook = async () => { reviewed(); await blocked; };
  const deleting = request(endpoint, "DELETE");
  try {
    await reached;
    for (const action of ["prompt", "synthetic", "command", "fork"])
      expect((await request(`/workspace/project/opencode/api/session/chat/${action}`, "POST", { text: "Continue" })).status).toBe(409);
    expect((await request(`${endpoint}/queue`, "POST", { type: "pause", paused: false })).status).toBe(409);
    expect((await request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" })).status).toBe(409);
    expect((await request(endpoint, "DELETE")).status).toBe(409);
    // Unrelated chats remain usable.
    expect((await request("/workspace/project/opencode/api/session/unrelated/prompt", "POST", { text: "Continue" })).status).toBe(200);
  } finally { release(); }
  expect((await deleting).status).toBe(409);
  state.reviewHook = undefined;
  expect((await request(`${endpoint}/queue`, "POST", { type: "pause", paused: false })).status).toBe(200);
});

test("a reserved send blocks deletion even before the engine reports busy", async () => {
  const { state, request, config } = await fixture();
  await withSessionExecution(config, "chat", async () => {
    expect((await request(endpoint, "DELETE")).status).toBe(409);
    expect(state.deleted).toBe(0);
  });
  const review = reviewSchema.parse(await (await request(`${endpoint}/views`)).json());
  expect((await request(`${endpoint}?discardReview=${review.reviewToken}`, "DELETE")).status).toBe(200);
});

test("server-mediated recovery admits the verified native request and deduplicates it", async () => {
  const { state, request } = await fixture();
  state.recovery = true;
  expect((await request(`${endpoint}/review-recovery`, "POST", { messageId: "old" })).status).toBe(409);
  expect(state.prompts).toBe(0);
  const concurrent = await Promise.all([request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" }), request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" })]);
  expect(concurrent.map(response => response.status)).toEqual([200, 200]);
  expect(state.prompts).toBe(1);
  expect(state.recoveryInput).toMatchObject({ id: "msg_review_recovery_human", metadata: { legalworkReviewRecovery: true, sourceUserID: "human" } });
  expect((await request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" })).status).toBe(200);
  expect(state.prompts).toBe(1);
});

test("a failed native recovery admission can be retried without losing the recovery or sending it twice", async () => {
  const { state, request } = await fixture(); state.recovery = true; state.syntheticFailure = true;
  expect((await request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" })).status).toBe(502);
  expect(state.prompts).toBe(0);
  expect((await request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" })).status).toBe(200);
  expect(state.prompts).toBe(1);
  expect((await request(`${endpoint}/review-recovery`, "POST", { messageId: "empty" })).status).toBe(200);
  expect(state.prompts).toBe(1);
});
