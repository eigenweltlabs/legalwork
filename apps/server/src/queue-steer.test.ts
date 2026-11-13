import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import type { QueueAction, QueueEntry } from "@legalwork/types/session-queue";
import { ApiError } from "./errors.js";
import { nativeQueueTransport, queueMessageID } from "./native-queue-transport.js";
import { SessionMessageQueue, type QueueTransport } from "./session-message-queue.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: "/fixture/server.json", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
function prompt(text = "Follow up"): Extract<QueueAction, { type: "enqueue" }> {
  return { type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text, parts: [{ type: "text", text }], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "prompt", text, model: { providerID: "saved", id: "queued-model" }, agent: "queued-agent" } };
}
function latch() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  expect(await check()).toBe(true);
}
async function queueAt(transport: QueueTransport, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), "legalwork-steer-"));
  const queue = new SessionMessageQueue(dir, transport);
  cleanups.push(async () => { queue.stop(); if (!directory) await rm(dir, { recursive: true, force: true }); });
  return { queue, dir };
}
// Exercise the installed 2.1.4 client's actual routes, payloads and envelopes.
function engine() {
  const pending = new Map<string, { id: string; type: "user"; delivery: "queue" | "steer" }>();
  const history = new Set<string>();
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const state = { active: true, offline: false, lostPrompt: false, lostPromotion: false, deliverOnPromotion: false, admitted: 0, preparations: 0, prepareFailure: false };
  const client = OpenCode.make({ baseUrl: "http://steer.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (state.offline) throw new Error("Engine unavailable");
    if (url.pathname === "/api/session/active") return Response.json({ data: state.active ? { s: { id: "s" } } : {} });
    if (url.pathname.endsWith("/inbox")) return Response.json({ data: [...pending.values()] });
    if (url.pathname.includes("/message/")) {
      const id = url.pathname.split("/").at(-1)!;
      if (!history.has(id)) throw new ApiError(404, "not_found", "Message not found");
      return Response.json({ data: { id, type: "user" } });
    }
    if (url.pathname.includes("/inbox/")) {
      expect(init?.method).toBe("PATCH");
      expect(body).toEqual({ delivery: "steer" });
      const id = url.pathname.split("/").at(-1)!;
      if (state.deliverOnPromotion) { pending.delete(id); history.add(id); throw new ApiError(409, "delivered", "Already delivered"); }
      const item = pending.get(id);
      if (!item) throw new ApiError(409, "missing", "No pending item");
      item.delivery = "steer";
      if (state.lostPromotion) { state.offline = true; throw new Error("Lost promotion response"); }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/prompt")) {
      const id = String(body.id);
      const item = pending.get(id) ?? { id, type: "user", delivery: body.delivery === "steer" ? "steer" : "queue" };
      if (!history.has(id) && !pending.has(id)) { state.admitted++; pending.set(id, item); }
      if (state.lostPrompt) { state.offline = true; throw new Error("Lost admission response"); }
      return Response.json({ data: item });
    }
    if (url.pathname === "/api/session/s" && !init?.body) return Response.json({ data: { outcome: "completed" } });
    if (url.pathname === "/api/session/s" || url.pathname.endsWith("/model") || url.pathname.endsWith("/agent")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }, { preconnect: fetch.preconnect }) });
  const transport = nativeQueueTransport(config, { client: async () => client, prepare: async () => {
    state.preparations++;
    if (state.prepareFailure) throw new Error("Preparation failed");
  } });
  return { pending, history, calls, state, transport };
}
const steer = (queue: SessionMessageQueue, id: string, revision: number) => queue.act("w", "s", { type: "steer", id, revision });

test("active steering preserves prepared content, active model/agent, other entries and manual pause", async () => {
  const native = engine(); const { queue } = await queueAt(native.transport);
  const first = prompt("First"), chosen = prompt("Chosen"), last = prompt("Last");
  chosen.execution = { kind: "prompt", id: "msg_stable", text: "Full prepared text\n<system-reminder>hidden context</system-reminder>",
    files: [{ uri: "file:///project/source.pdf", name: "source.pdf", mention: { start: 2, end: 6, text: "file" } }],
    agents: [{ name: "mentioned-agent" }], skills: [{ id: "research", mention: { start: 7, end: 15, text: "research" } }],
    metadata: { legalworkPrompt: { visibleText: "Chosen", reminders: ["hidden context"] } }, model: { providerID: "saved", id: "ignored" }, agent: "ignored" };
  chosen.draft.attachments.push({ id: "pdf", name: "source.pdf", size: 2, kind: "file", mimeType: "application/pdf", data: "data:application/pdf;base64,aGk=" });
  chosen.draft.editor.mentions.source = "file";
  for (const item of [first, chosen, last]) await queue.act("w", "s", item);
  const before = await queue.act("w", "s", { type: "pause", paused: true, reason: "stop" });
  const after = await steer(queue, chosen.id, before.revision);
  expect(after.entries.map(item => item.id)).toEqual([first.id, chosen.id, last.id]);
  expect(after.entries[1]).toMatchObject({ status: "accepted", delivery: "steer", draft: chosen.draft, execution: chosen.execution });
  expect(after.entries[0]).toEqual(before.entries[0]); expect(after.entries[2]).toEqual(before.entries[2]);
  expect(after.paused).toBe(true); expect(after.pauseReason).toBe("stop");
  const { kind, model, agent, ...payload } = chosen.execution;
  expect(native.calls.filter(call => call.path.endsWith("/prompt")).map(call => call.body)).toEqual([{ ...payload, delivery: "steer" }]);
  expect(native.calls.some(call => /\/(model|agent|interrupt|shell)$/.test(call.path))).toBe(false);
  expect(native.state.preparations).toBe(1);
});

test("duplicate clicks and stale retries after completion never admit another input", async () => {
  const native = engine(); const { queue } = await queueAt(native.transport);
  const item = prompt(); const initial = await queue.act("w", "s", item);
  await Promise.all([steer(queue, item.id, initial.revision), steer(queue, item.id, initial.revision)]);
  expect(native.state.admitted).toBe(1);
  expect(native.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(1);
  native.pending.clear(); native.history.add(queueMessageID(item)); native.state.active = false;
  // settled reads outcome only after active/inbox are empty.
  await queue.tick();
  expect((await queue.read("w", "s")).completedIds).toContain(item.id);
  await steer(queue, item.id, initial.revision);
  expect(native.state.admitted).toBe(1);
});

test("edit leases, stale edited content and command entries reject steering", async () => {
  const { queue } = await queueAt({ idle: async () => false, send: async () => { throw Error("Must not send"); } });
  const item = prompt(); const initial = await queue.act("w", "s", item); const token = crypto.randomUUID();
  const editing = await queue.act("w", "s", { type: "edit", id: item.id, token, revision: initial.revision });
  await expect(steer(queue, item.id, editing.revision)).rejects.toThrow("queue changed");
  await queue.act("w", "s", { ...item, editToken: token, execution: { kind: "prompt", text: "Edited" } });
  await expect(steer(queue, item.id, initial.revision)).rejects.toThrow("queue changed");
  for (const execution of [{ kind: "command", command: "review", args: "" }, { kind: "shell", command: "pwd" }] satisfies QueueEntry["execution"][]) {
    const entry = { ...prompt(), execution }; const state = await queue.act("w", "s", entry);
    await expect(steer(queue, entry.id, state.revision)).rejects.toThrow("queue changed");
  }
});

test("an unresolved ordinary delivery cannot be steered or discarded", async () => {
  const native = engine(); native.state.active = false; native.state.lostPrompt = true;
  const { queue } = await queueAt(native.transport);
  const item = prompt(); await queue.act("w", "s", item);
  await until(async () => (await queue.read("w", "s")).entries[0]?.status === "uncertain");
  const state = await queue.read("w", "s");
  await expect(steer(queue, item.id, state.revision)).rejects.toThrow("queue changed");
  await expect(queue.act("w", "s", { type: "remove", id: item.id, revision: state.revision })).rejects.toThrow("queue changed");
  expect((await queue.read("w", "s")).entries[0].draft).toEqual(item.draft);
  expect(native.state.admitted).toBe(1);
});

test("a slow ordinary admission is promoted in place with the same native identity", async () => {
  const native = engine(); native.state.active = false;
  const entered = latch(), release = latch();
  const transport: QueueTransport = { ...native.transport, send: async (w, s, entry) => {
    if (entry.delivery !== "steer") { entered.release(); await release.promise; }
    return native.transport.send(w, s, entry);
  } };
  const { queue } = await queueAt(transport);
  const item = prompt(); const initial = await queue.act("w", "s", item);
  await entered.promise;
  const operation = steer(queue, item.id, initial.revision);
  await until(async () => (await queue.read("w", "s")).entries[0].delivery === "steer");
  native.state.active = true; release.release();
  expect((await operation).entries[0]).toMatchObject({ delivery: "steer", status: "accepted" });
  expect(native.state.admitted).toBe(1);
  expect(native.pending.get(queueMessageID(item))?.delivery).toBe("steer");
  expect(native.calls.filter(call => call.path.includes("/inbox/") && call.method === "PATCH")).toHaveLength(1);
});

test("steering wins a pending idle check without dispatching the ordinary head or changing order", async () => {
  const idle = latch(); let checking = false; const sent: QueueEntry[] = [];
  const { queue } = await queueAt({ idle: async () => { checking = true; await idle.promise; return true; }, send: async (_w, _s, entry) => { sent.push(entry); return { accepted: true }; } });
  const first = prompt(); const enqueuing = queue.act("w", "s", first);
  await until(async () => checking);
  // read() waits for the idle check; known content revision is 1.
  const steering = steer(queue, first.id, 1);
  await until(async () => sent.length === 1); idle.release();
  await Promise.all([enqueuing, steering]);
  expect(sent.map(entry => entry.delivery)).toEqual(["steer"]);
});

test("already delivered and delivery racing promotion reconcile without another prompt", async () => {
  for (const pending of [false, true]) {
    const native = engine(); const { queue } = await queueAt(native.transport);
    const item = prompt(); const initial = await queue.act("w", "s", item); const id = queueMessageID(item);
    if (pending) { native.pending.set(id, { id, type: "user", delivery: "queue" }); native.state.deliverOnPromotion = true; }
    else native.history.add(id);
    expect((await steer(queue, item.id, initial.revision)).entries[0].status).toBe("accepted");
    expect(native.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(0);
    expect(native.calls.some(call => call.path.endsWith("/model") || call.path.endsWith("/agent"))).toBe(false);
  }
});

test("finishing before steer admission delivers once as the next input with the active selection", async () => {
  const native = engine(); const { queue } = await queueAt(native.transport);
  const item = prompt(); const initial = await queue.act("w", "s", item);
  native.state.active = false;
  expect((await steer(queue, item.id, initial.revision)).entries[0].status).toBe("accepted");
  expect(native.state.admitted).toBe(1);
  expect(native.calls.some(call => call.path.endsWith("/model") || call.path.endsWith("/agent"))).toBe(false);
});

test("lost admission and promotion responses survive restart without duplicate admission or changing pause", async () => {
  for (const promotion of [false, true]) {
    const native = engine(); const { queue, dir } = await queueAt(native.transport);
    const item = prompt(); const initial = await queue.act("w", "s", item); const id = queueMessageID(item);
    if (promotion) { native.pending.set(id, { id, type: "user", delivery: "queue" }); native.state.lostPromotion = true; }
    else native.state.lostPrompt = true;
    const state = await steer(queue, item.id, initial.revision);
    expect(state.entries[0]).toMatchObject({ delivery: "steer", status: "uncertain", draft: item.draft });
    expect(state.paused).toBe(false);
    await expect(queue.act("w", "s", { type: "edit", id: item.id, token: crypto.randomUUID(), revision: state.revision })).rejects.toThrow();
    await expect(queue.act("w", "s", { type: "remove", id: item.id, revision: state.revision })).rejects.toThrow();
    queue.stop(); native.state.offline = false; native.state.lostPrompt = false; native.state.lostPromotion = false;
    const { queue: restarted } = await queueAt(native.transport, dir);
    await restarted.tick();
    expect((await restarted.read("w", "s")).entries[0]).toMatchObject({ status: "accepted", delivery: "steer" });
    expect((await restarted.read("w", "s")).paused).toBe(false);
    expect(native.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(promotion ? 0 : 1);
  }
});

test("a restart between persisting steer intent and admission retries the same prepared prompt", async () => {
  const entered = latch();
  const { queue, dir } = await queueAt({ idle: async () => false, send: async () => { entered.release(); await new Promise(() => {}); } });
  const item = prompt(); const initial = await queue.act("w", "s", item);
  void steer(queue, item.id, initial.revision);
  await entered.promise;
  const file = (await readdir(dir)).find(file => file.endsWith(".json"))!;
  expect(JSON.parse(await readFile(join(dir, file), "utf8")).entries[0]).toMatchObject({ delivery: "steer", status: "sending" });
  queue.stop();
  const native = engine(); const { queue: restarted } = await queueAt(native.transport, dir);
  await restarted.tick();
  expect((await restarted.read("w", "s")).entries[0]).toMatchObject({ status: "accepted", delivery: "steer", draft: item.draft });
  expect(native.state.admitted).toBe(1);
  expect((await restarted.read("w", "s")).paused).toBe(false);
});

test("definite failures retain the draft, retry as steer and never apply queued selection", async () => {
  const native = engine(); const { queue } = await queueAt(native.transport);
  const item = prompt(); const initial = await queue.act("w", "s", item);
  native.state.prepareFailure = true;
  const failed = await steer(queue, item.id, initial.revision);
  expect(failed.entries[0]).toMatchObject({ status: "failed", delivery: "steer", draft: item.draft, error: "Preparation failed" });
  expect(failed.paused).toBe(false);
  native.state.prepareFailure = false;
  expect((await steer(queue, item.id, failed.revision)).entries[0].status).toBe("accepted");
  expect(native.calls.some(call => call.path.endsWith("/model") || call.path.endsWith("/agent"))).toBe(false);
});
