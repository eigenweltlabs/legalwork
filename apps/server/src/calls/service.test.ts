import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AssistantCalls, CallOffer, CallWork } from "./service.js";
import type { AssistantQueuedMessage } from "../assistant-session-queue.js";

async function fixture(waitForRealtime?: Promise<void>) {
  let now = 100000, creates = 0, requests = 0, closes = 0, busy = false, delegated = false;
  const receipts: AssistantQueuedMessage[] = [];
  const tracked: string[] = [];
  const engine = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session" && request.method === "POST") { creates++; return Response.json({ id: "voice-session", directory: "/tmp/assistant", title: "Call · test", time: {} }); }
    if (path === "/session/status") return Response.json(busy ? { "voice-session": { type: "busy" } } : {});
    if (path.endsWith("/message")) return Response.json([{ info: { id: "reply", role: "assistant", time: { created: 1, completed: 2 }, providerID: "test", modelID: "test" }, parts: [{ type: "text", text: "Ready." }, { type: "text", synthetic: true, text: "private control text" }] }]);
    return new Response(null, { status: 404 });
  } });
  const client = createOpencodeClient({ baseUrl: engine.url.origin });
  const calls = new AssistantCalls({
    assistant: { current: async () => ({ workspace: { id: "assistant", name: "Assistant", path: "/tmp/assistant", workspaceType: "local", preset: "main-assistant" }, day: { date: "2026-10-09", sessionId: "day" } }), profile: () => ({ name: "Custom name", icon: "professional_owl" }) },
    client: () => client, delegations: { hasPendingSessionWork: () => delegated, track: d => { tracked.push(d.sessionId); } },
    queue: {
      submit: async (target, prompt, requestId) => {
        const existing = receipts.find(r => r.requestId === requestId);
        if (existing) return existing;
        const receipt: AssistantQueuedMessage = { ...target, id: "msg-test", prompt, requestId, state: "queued", createdAt: now, allowInterrupted: false, error: null };
        receipts.push(receipt); return receipt;
      },
      receipt: (_target, _prompt, requestId) => receipts.find(r => r.requestId === requestId) ?? null,
    },
    realtime: async input => { requests++; await waitForRealtime; expect(input.sessionContext).toContain("Custom name"); return { sdp: "answer", close: async () => { closes++; } }; },
    available: async () => ({ supported: true }), changed: () => {}, now: () => now,
  });
  return { calls, receipts, tracked, stop: () => engine.stop(true), setTime: (value: number) => { now = value; }, setBusy: (value: boolean) => { busy = value; }, setDelegated: (value: boolean) => { delegated = value; }, counts: () => ({ creates, requests }), closes: () => closes };
}
const offer = { id: "918b17e8-1b82-4e82-94bf-d33f9270181d", sdp: "v=0" };
test("native call setup is idempotent and isolates owners and concurrent calls", async () => {
  const f = await fixture();
  try {
    const [a,b] = await Promise.all([f.calls.create("alice", offer), f.calls.create("alice", offer)]);
    expect(a).toEqual(b); expect(f.counts()).toEqual({ creates: 1, requests: 1 });
    await expect(f.calls.create("bob", offer)).rejects.toThrow("no longer available");
    await expect(f.calls.state(offer.id, "bob")).rejects.toThrow("no longer available");
    await expect(f.calls.create("alice", { ...offer, id: "7dbe901e-0a9d-4014-94e0-022d21472035" })).rejects.toThrow("current call");
    expect(f.calls.isActiveSession("voice-session")).toBe(true);
    f.setTime(161000); expect(f.calls.isActiveSession("voice-session")).toBe(false);
    await expect(f.calls.state(offer.id, "alice")).rejects.toThrow("ended");
  } finally { f.stop(); }
});
test("accepted voice requests use the durable queue and survive hang-up without duplication", async () => {
  const f = await fixture();
  try {
    await f.calls.create("alice", offer);
    const work = { id: "tool-1", request: "Find the Acme client matter and delegate an NDA review." };
    await Promise.all([f.calls.work(offer.id, "alice", work), f.calls.work(offer.id, "alice", work)]);
    expect(f.receipts.length).toBe(1);
    expect((await f.calls.state(offer.id, "alice")).work.length).toBe(1);
    expect(f.receipts[0].prompt).toContain(work.request);
    expect(f.receipts[0].prompt).toContain("client/matter metadata");
    expect(f.receipts[0].prompt.length).toBeLessThanOrEqual(12000);
    await expect(f.calls.work(offer.id, "alice", { ...work, request: "Different request" })).rejects.toThrow("already used");
    expect((await f.calls.state(offer.id, "alice")).busy).toBe(true);
    f.calls.end(offer.id, "alice"); f.calls.end(offer.id, "alice");
    expect(f.closes()).toBe(1);
    expect(f.receipts[0].state).toBe("queued"); expect(f.tracked).toContain("voice-session");
    expect(f.calls.isActiveSession("voice-session")).toBe(false);
    await expect(f.calls.work(offer.id, "alice", work)).rejects.toThrow("ended");
  } finally { f.stop(); }
});
test("voice progress excludes hidden control text and remains working for project delegation", async () => {
  const f = await fixture();
  try {
    await f.calls.create("alice", offer);
    f.setDelegated(true);
    const state = await f.calls.state(offer.id, "alice");
    expect(state.busy).toBe(true); expect(state.updates).toEqual([{ id: "reply", text: "Ready." }]);
    f.setTime(100000 + 2 * 60 * 60 * 1000 + 1);
    await expect(f.calls.state(offer.id, "alice")).rejects.toThrow("ended");
  } finally { f.stop(); }
});
test("call schemas bound requests and reject client-supplied scope or session IDs", () => {
  expect(CallOffer.safeParse({ ...offer, owner: "someone-else" }).success).toBe(false);
  expect(CallWork.safeParse({ id: "x", request: "x".repeat(8001) }).success).toBe(false);
  expect(CallWork.safeParse({ id: "x", request: "hello", sessionId: "another-session" }).success).toBe(false);
});

test("hang-up during SDP negotiation cancels setup without starting work", async () => {
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(pending);
  try {
    const setup = f.calls.create("alice", offer);
    for (let attempt = 0; f.counts().requests === 0 && attempt < 100; attempt++) await Bun.sleep(1);
    expect(f.counts().requests).toBe(1);
    f.calls.end(offer.id, "alice");
    release();
    await expect(setup).rejects.toThrow("ended");
    expect(f.closes()).toBe(1);
    expect(f.calls.isActiveSession("voice-session")).toBe(false);
    expect(f.receipts).toEqual([]);
    await expect(f.calls.create("alice", offer)).rejects.toThrow("ended");
  } finally { release(); f.stop(); }
});

test("lost heartbeat hangs up provider audio while preserving accepted work", async () => {
  const f = await fixture();
  try {
    await f.calls.create("alice", offer);
    await f.calls.work(offer.id, "alice", { id: "work", request: "Check projects" });
    f.setTime(161000); f.calls.expire(); f.calls.expire();
    expect(f.closes()).toBe(1);
    expect(f.receipts.length).toBe(1);
    await expect(f.calls.state(offer.id, "alice")).rejects.toThrow("ended");
  } finally { f.stop(); }
});
