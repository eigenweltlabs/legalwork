import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceInfo } from "../types.js";
import { ReviewSessions, type ReviewSessionClient } from "./sessions.js";
import { ReviewStore } from "./storage.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(sessionId: string | null | undefined = null) {
  const root = await mkdtemp(join(tmpdir(), "review-session-")); roots.push(root);
  const workspace: WorkspaceInfo = { id: "project", name: "Test", path: root, preset: "starter", workspaceType: "local" };
  const store = new ReviewStore(root);
  const review = await store.create({ id: randomUUID(), name: "Commercial review", revision: 0, createdAt: 10, updatedAt: 10,
    settings: { mode: "llm", jev: null, llm: null }, columns: [], documents: [], cells: [], status: "draft", runId: null, error: null, sessionId });
  const sessions = new Map<string, { id: string; directory: string; time: { created: number; updated: number; archived?: number } }>();
  const messages = new Map<string, Array<{ parts: unknown[] }>>();
  const calls = { create: 0, list: 0, unarchive: 0 };
  const client: ReviewSessionClient = {
    get: async id => sessions.get(id) ?? null,
    list: async () => { calls.list++; return [...sessions.values()]; },
    messages: async id => messages.get(id) ?? [],
    create: async () => { calls.create++; const session = { id: `ses_${calls.create}`, directory: root, time: { created: 20, updated: 20 } }; sessions.set(session.id, session); return session; },
    unarchive: async id => { calls.unarchive++; const session = sessions.get(id); if (session) session.time.archived = 0; },
  };
  return { root, workspace, store, review, sessions, messages, calls, client, service: new ReviewSessions(() => client) };
}
test("manual review discussions deduplicate concurrent clicks and retries, preserving review data", async () => {
  const f = await fixture();
  expect(await f.service.get(f.workspace, f.review.id)).toEqual({ sessionId: null });
  const links = await Promise.all(Array.from({ length: 3 }, () => f.service.open(f.workspace, f.review.id)));
  expect(links).toEqual(Array(3).fill({ sessionId: "ses_1", prefill: true }));
  expect(f.calls).toEqual({ create: 1, list: 0, unarchive: 0 });
  const stored = await f.store.read(f.review.id);
  expect(stored).toMatchObject({ sessionId: "ses_1", sessionCreatedForReview: true, status: "draft", columns: [], cells: [], revision: 1 });
  f.messages.set("ses_1", [{ parts: [{ type: "text", text: "Existing conversation" }] }]);
  expect(await new ReviewSessions(() => f.client).open(f.workspace, f.review.id)).toEqual({ sessionId: "ses_1", prefill: false });
});
test("agent origin continues the same archived session without prefilling or creating another", async () => {
  const f = await fixture("source");
  f.sessions.set("source", { id: "source", directory: f.root, time: { created: 1, updated: 20, archived: 20 } });
  expect(await f.service.get(f.workspace, f.review.id)).toEqual({ sessionId: "source" });
  expect(await f.service.open(f.workspace, f.review.id)).toEqual({ sessionId: "source", prefill: false });
  expect(f.calls).toEqual({ create: 0, list: 0, unarchive: 1 });
  expect((await f.store.read(f.review.id)).revision).toBe(0);
});
test("old reviews recover their origin only from exact successful project-scoped review tools", async () => {
  const f = await fixture();
  await f.store.update(f.review.id, review => { delete review.sessionId; });
  const output = JSON.stringify({ ok: true, workspaceId: f.workspace.id, review: { id: f.review.id } });
  for (const id of ["wrong", "source"]) f.sessions.set(id, { id, directory: f.root, time: { created: 1, updated: 20 } });
  f.messages.set("wrong", [{ parts: [{ type: "text", text: output }, { type: "tool", tool: "legalwork_review_results", state: { status: "completed", output } }] }]);
  f.messages.set("source", [{ parts: [{ type: "tool", tool: "legalwork_review_start", state: { status: "completed", output } }] }]);
  expect(await f.service.get(f.workspace, f.review.id)).toEqual({ sessionId: "source" });
  expect(await f.service.open(f.workspace, f.review.id)).toEqual({ sessionId: "source", prefill: false });
  expect(f.calls.create).toBe(0); expect(f.calls.list).toBe(1);
  expect((await f.store.read(f.review.id)).sessionId).toBe("source");
});
test("deleted or foreign-project origins open a new project session, never a broken or foreign link", async () => {
  for (const foreign of [false, true]) {
    const f = await fixture("source");
    if (foreign) f.sessions.set("source", { id: "source", directory: `${f.root}-sibling`, time: { created: 1, updated: 20 } });
    expect(await f.service.get(f.workspace, f.review.id)).toEqual({ sessionId: null });
    expect(await f.service.open(f.workspace, f.review.id)).toEqual({ sessionId: "ses_1", prefill: true });
  }
});
test("engine errors do not masquerade as a missing session or create duplicates", async () => {
  const f = await fixture("source");
  f.client.get = async () => { throw new Error("Engine unavailable"); };
  await expect(f.service.open(f.workspace, f.review.id)).rejects.toThrow("Engine unavailable");
  expect(f.calls.create).toBe(0);
});
