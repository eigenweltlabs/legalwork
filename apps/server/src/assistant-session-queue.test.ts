import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantSessionQueue, type AssistantQueueExecutor, type AssistantQueuedMessage } from "./assistant-session-queue.js";

const target = { workspaceId: "matter", sessionId: "review" };
test("busy follow-ups persist in order, can be edited/cancelled, and confirm lost delivery without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-queue-"));
  const path = join(root, "runtime.sqlite");
  let busy = true, pending = false, loseResponse = true;
  const saved = new Set<string>();
  const sent: AssistantQueuedMessage[] = [];
  const executor: AssistantQueueExecutor = {
    inspect: async () => ({ busy, pending, interrupted: false }),
    hasMessage: async (_, id) => saved.has(id),
    send: async entry => { sent.push(entry); saved.add(entry.id); busy = true; if (loseResponse) throw new Error("Response lost"); },
    abort: async () => { busy = false; },
  };
  try {
    const queue = await AssistantSessionQueue.open(path, executor);
    const first = await queue.submit(target, "Review pricing", "original-request");
    expect((await queue.submit(target, "Review pricing")).id).toBe(first.id);
    const second = await queue.submit(target, "Summarize next steps");
    const third = await queue.submit(target, "Unneeded extra review");
    await queue.update(target, second.id, "edit", "Summarize risks");
    await queue.update(target, third.id, "cancel");
    expect(sent).toEqual([]);
    const restarted = await AssistantSessionQueue.open(path, executor);
    expect(restarted.list(target).map(entry => entry.prompt)).toEqual(["Review pricing", "Summarize risks"]);
    busy = false; pending = true;
    await restarted.tick(); expect(sent).toHaveLength(0);
    pending = false;
    await Promise.all([restarted.tick(), restarted.tick()]);
    expect(sent).toHaveLength(1);
    expect(restarted.list(target)[0].state).toBe("sending");
    await restarted.tick();
    expect(sent).toHaveLength(1);
    expect(restarted.list(target)).toHaveLength(1);
    expect((await restarted.submit(target, "Review pricing", "original-request")).state).toBe("sent");
    expect(sent).toHaveLength(1);
    busy = false; loseResponse = false;
    await restarted.tick();
    expect(sent.map(entry => entry.prompt)).toEqual(["Review pricing", "Summarize risks"]);
    expect(restarted.list(target)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stopping a parent also cancels its child follow-ups", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-child-stop-"));
  const child = { ...target, sessionId: "child" };
  let busy = true;
  const sent: string[] = [];
  const queue = await AssistantSessionQueue.open(join(root, "runtime.sqlite"), {
    inspect: async () => ({ busy, pending: false, interrupted: false }), hasMessage: async () => true,
    send: async entry => { sent.push(entry.prompt); }, abort: async () => { busy = false; return [target.sessionId, child.sessionId]; },
  });
  try {
    await queue.submit(target, "Parent next step");
    await queue.submit(child, "Child next step");
    expect((await queue.stop(target)).cancelledQueuedMessages).toBe(2);
    await queue.tick();
    expect(sent).toEqual([]); expect(queue.list(child)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stop cancels pending work; external interruptions pause instead of restarting the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-stop-"));
  let busy = true, interrupted = false, stops = 0;
  const sent: string[] = [];
  const queue = await AssistantSessionQueue.open(join(root, "runtime.sqlite"), {
    inspect: async () => ({ busy, pending: false, interrupted }), hasMessage: async () => true,
    send: async entry => { sent.push(entry.prompt); busy = true; },
    abort: async () => { busy = false; interrupted = true; stops++; },
  });
  try {
    await queue.submit(target, "Continue later");
    expect(await queue.stop(target)).toEqual({ stopped: true, cancelledQueuedMessages: 1 });
    await queue.tick(); expect(sent).toEqual([]); expect(stops).toBe(1);
    expect((await queue.submit(target, "Review only for the provider")).state).toBe("sent");
    const next = await queue.submit(target, "Then summarize");
    busy = false; interrupted = true;
    await queue.tick();
    expect(queue.list(target)[0].state).toBe("paused");
    expect(sent).toEqual(["Review only for the provider"]);
    await queue.update(target, next.id, "resume");
    await queue.tick(); expect(sent).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
