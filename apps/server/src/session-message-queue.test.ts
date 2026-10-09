import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueAction } from "@legalwork/types/session-queue";
import { QueuePreparationError, SessionMessageQueue, type QueueTransport } from "./session-message-queue.js";
import { queueActionSchema, queuedPromptPayload } from "./session-queue-schema.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
const message = (text = "hello"): Extract<QueueAction, { type: "enqueue" }> => ({ type: "enqueue", id: crypto.randomUUID(), draft: { mode: "prompt", text, parts: [{ type: "text", text }], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "prompt", model: { providerID: "test", modelID: "test" }, parts: [{ type: "text", text }] } });
async function setup(transport: QueueTransport) {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-queue-test-"));
  const queue = new SessionMessageQueue(dir, transport);
  cleanups.push(async () => { queue.stop(); await rm(dir, { recursive: true, force: true }); });
  return { queue, dir };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); }
  expect(await check()).toBe(true);
}
test("an idle enqueue is acknowledged as sending without waiting for its reply", async () => {
  const sent: string[] = [];
  const { queue } = await setup({ idle: async () => true, send: async (_w, _s, entry) => { sent.push(entry.id); await new Promise(() => {}); } });
  const first = message("start immediately");
  const state = await queue.act("w", "s", first);
  expect(sent).toEqual([first.id]);
  expect(state.entries.map(entry => entry.status)).toEqual(["sending"]);
  const waiting = await queue.act("w", "s", message("follow-up"));
  expect(waiting.entries.map(entry => entry.status)).toEqual(["sending", "queued"]);
  expect(sent).toEqual([first.id]);
});
test("polling and concurrent enqueues wait for the same dispatch decision", async () => {
  let release = () => {};
  let checks = 0;
  const idle = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const { queue } = await setup({ idle: async () => { checks++; return idle; }, send: () => new Promise(() => {}) });
  const first = message("one"), second = message("two");
  const sending = queue.act("w", "s", first);
  await until(async () => checks === 1);
  let published = false;
  const reading = queue.read("w", "s").then(state => { published = true; return state; });
  const waiting = queue.act("w", "s", second);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(published).toBe(false);
  release();
  const states = await Promise.all([sending, reading, waiting]);
  expect(checks).toBe(1);
  for (const state of states) {
    expect(state.entries.map(entry => entry.id)).toEqual([first.id, second.id]);
    expect(state.entries.map(entry => entry.status)).toEqual(["sending", "queued"]);
  }
});
test("busy and paused conversations keep new messages visibly queued", async () => {
  const { queue } = await setup({ idle: async () => false, send: async () => { throw new Error("Must not dispatch"); } });
  expect((await queue.act("w", "busy", message())).entries[0].status).toBe("queued");
  await queue.act("w", "paused", { type: "pause", paused: true });
  const paused = await queue.act("w", "paused", message());
  expect(paused.paused).toBe(true);
  expect(paused.entries[0].status).toBe("queued");
});
test("Stop can pause while an idle check is pending, before delivery is claimed", async () => {
  let release = () => {};
  let checking = false, sends = 0;
  const idle = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const { queue } = await setup({ idle: async () => { checking = true; return idle; }, send: async () => { sends++; } });
  const sending = queue.act("w", "s", message());
  await until(async () => checking);
  const paused = await queue.act("w", "s", { type: "pause", paused: true, reason: "stop" });
  expect(paused.paused).toBe(true);
  release();
  expect((await sending).entries[0].status).toBe("queued");
  expect(sends).toBe(0);
});
test("two windows enqueue durably and only one dispatcher sends in order", async () => {
  const sent: string[] = []; let idle = false; let release = () => {};
  const pending = new Promise<void>(r => { release = r; });
  const { queue } = await setup({ idle: async () => idle, send: async (_w, _s, entry) => { sent.push(entry.id); await pending; } });
  const a = message("one"), b = message("two");
  await Promise.all([queue.act("w", "s", a), queue.act("w", "s", b)]);
  expect((await queue.read("w", "s")).entries.map(e => e.id)).toEqual([a.id, b.id]);
  idle = true; await Promise.all([queue.tick(), queue.tick()]);
  await until(async () => sent.length === 1);
  expect(sent).toEqual([a.id]);
  release(); await until(async () => (await queue.read("w", "s")).entries.length === 1);
  await queue.tick(); await until(async () => (await queue.read("w", "s")).entries.length === 0);
  expect(sent).toEqual([a.id, b.id]);
  await queue.act("w", "s", a); // Retry after a lost acknowledgement must not send again.
  expect((await queue.read("w", "s")).entries).toEqual([]);
});
test("restart retains queued attachments, pause, order and independent conversations", async () => {
  const transport = { idle: async () => false, send: async () => {} };
  const { queue, dir } = await setup(transport);
  const a = message(); a.draft.attachments.push({ id: "attachment", name: "sample.txt", mimeType: "text/plain", size: 2, kind: "file", data: "data:text/plain;base64,aGk=" });
  await queue.act("w", "s", a); await queue.act("w", "s", { type: "pause", paused: true }); queue.stop();
  const restored = new SessionMessageQueue(dir, transport); cleanups.push(async () => restored.stop());
  expect((await restored.read("w", "s")).entries[0].draft).toEqual(a.draft);
  expect((await restored.read("w", "s")).paused).toBe(true);
  expect((await restored.read("other", "s")).entries).toEqual([]);
});
test("hidden queued context survives validation and restart without changing the system prompt", async () => {
  const transport = { idle: async () => false, send: async () => {} };
  const { queue, dir } = await setup(transport);
  const a = message();
  if (a.execution.kind !== "prompt") throw new Error("Expected prompt");
  const reminder: (typeof a.execution.parts)[number] = { type: "text", text: "<system-reminder>\nAttachment context\n</system-reminder>", synthetic: true };
  const parsed = queueActionSchema.parse({ ...a, execution: { ...a.execution, parts: [...a.execution.parts, reminder] } });
  await queue.act("w", "s", parsed); queue.stop();
  const restored = new SessionMessageQueue(dir, transport); cleanups.push(async () => restored.stop());
  const execution = (await restored.read("w", "s")).entries[0].execution;
  if (execution.kind !== "prompt") throw new Error("Expected prompt");
  const payload = queuedPromptPayload(execution);
  expect(payload.parts).toEqual([...a.execution.parts, reminder]);
  expect(payload).not.toHaveProperty("system");
  expect(payload).not.toHaveProperty("kind");
});
test("legacy queued context dispatches as a hidden message part without mutating the saved entry", () => {
  const execution = message().execution;
  if (execution.kind !== "prompt") throw new Error("Expected prompt");
  execution.system = "Legacy Fusion and attachment context";
  const payload = queuedPromptPayload(execution);
  expect(payload).not.toHaveProperty("system");
  expect(payload.parts.at(-1)).toEqual({ type: "text", text: "<system-reminder>\nLegacy Fusion and attachment context\n</system-reminder>", synthetic: true });
  expect(queuedPromptPayload(execution)).toEqual(payload);
  expect(execution.parts).toHaveLength(1);
});
test("editing reserves the item across windows; stale changes cannot overwrite it", async () => {
  const { queue } = await setup({ idle: async () => false, send: async () => {} });
  const a = message(); const state = await queue.act("w", "s", a); const token = crypto.randomUUID();
  const editing = await queue.act("w", "s", { type: "edit", id: a.id, token, revision: state.revision });
  await expect(queue.act("w", "s", { type: "edit", id: a.id, token: crypto.randomUUID(), revision: editing.revision })).rejects.toThrow();
  await expect(queue.act("w", "s", { type: "pause", paused: false })).rejects.toThrow();
  await expect(queue.act("w", "s", { type: "remove", id: a.id, revision: editing.revision })).rejects.toThrow();
  const changed = await queue.act("w", "s", { ...a, editToken: token, draft: { ...a.draft, text: "edited" } });
  expect(changed.entries[0].draft.text).toBe("edited"); expect(changed.entries[0].edit).toBeUndefined();
});
test("uncertain delivery pauses the queue and never retries automatically", async () => {
  let sends = 0;
  const { queue } = await setup({ idle: async () => true, send: async () => { sends++; throw new Error("Connection lost after acceptance"); } });
  await queue.act("w", "s", message());
  await until(async () => (await queue.read("w", "s")).paused);
  expect((await queue.read("w", "s")).entries[0].status).toBe("uncertain");
  await expect(queue.act("w", "s", { type: "pause", paused: false })).rejects.toThrow();
  await queue.tick(); expect(sends).toBe(1);
});

test("a server restart does not resend a dispatch that might already have been accepted", async () => {
  const { queue, dir } = await setup({ idle: async () => true, send: () => new Promise(() => {}) });
  const item = message("interrupted");
  await queue.act("w", "s", item);
  await until(async () => (await queue.read("w", "s")).entries[0]?.status === "sending");
  queue.stop();
  let sends = 0;
  const restored = new SessionMessageQueue(dir, { idle: async () => true, send: async () => { sends++; } });
  cleanups.push(async () => restored.stop());
  const state = await restored.read("w", "s");
  expect(state.paused).toBe(true);
  expect(state.entries[0].status).toBe("uncertain");
  expect(state.entries[0].draft.text).toBe("interrupted");
  await restored.tick();
  expect(sends).toBe(0);
});

test("a lost edit acknowledgement can be retried without overwriting a later edit", async () => {
  const { queue } = await setup({ idle: async () => false, send: async () => {} });
  const a = message();
  const initial = await queue.act("w", "s", a);
  const token = crypto.randomUUID();
  await queue.act("w", "s", { type: "edit", id: a.id, token, revision: initial.revision });
  const edit = { ...a, editToken: token, draft: { ...a.draft, text: "changed" } };
  await queue.act("w", "s", edit);
  const retry = await queue.act("w", "s", edit);
  expect(retry.entries).toHaveLength(1);
  expect(retry.entries[0].draft.text).toBe("changed");
  expect(retry.paused).toBe(false);
});

test("a deleted session cannot dispatch queued work", async () => {
  let idle = false, sends = 0;
  const { queue, dir } = await setup({ idle: async () => idle, send: async () => { sends++; } });
  const a = message();
  await queue.act("w", "s", a);
  await queue.removeSession("w", "s");
  idle = true;
  await queue.tick();
  await expect(queue.act("w", "s", a)).rejects.toThrow("deleted");
  expect((await queue.read("w", "s")).entries).toHaveLength(0);
  expect(await readdir(dir)).toEqual([]);
  expect(sends).toBe(0);
});

test("an expired editor cannot acknowledge a draft removed by another window", async () => {
  const { queue } = await setup({ idle: async () => false, send: async () => {} });
  const item = message(); const token = crypto.randomUUID();
  const initial = await queue.act("w", "s", item);
  const editing = await queue.act("w", "s", { type: "edit", id: item.id, token, revision: initial.revision });
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
  try {
    await queue.act("w", "s", { type: "remove", id: item.id, revision: editing.revision });
    await expect(queue.act("w", "s", { ...item, editToken: token })).rejects.toThrow("queue changed");
    expect((await queue.read("w", "s")).entries).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("edit leases suspend delivery without changing manual pause; release, submit and expiry resume", async () => {
  const { queue } = await setup({ idle: async () => false, send: async () => {} });
  const item = message(); let state = await queue.act("w", "s", item);
  const token = crypto.randomUUID();
  state = await queue.act("w", "s", { type: "edit", id: item.id, token, revision: state.revision });
  expect(state.paused).toBe(false);
  state = await queue.act("w", "s", { type: "release", id: item.id, token });
  expect(state.paused).toBe(false); expect(state.entries[0].edit).toBeUndefined();
  state = await queue.act("w", "s", { type: "edit", id: item.id, token, revision: state.revision });
  state = await queue.act("w", "s", { ...item, editToken: token });
  expect(state.paused).toBe(false); expect(state.entries[0].edit).toBeUndefined();
  const nextToken = crypto.randomUUID();
  await queue.act("w", "s", { type: "edit", id: item.id, token: nextToken, revision: state.revision });
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
  try { await queue.tick(); } finally { clock.mockRestore(); }
  state = await queue.read("w", "s");
  expect(state.paused).toBe(false); expect(state.entries[0].edit).toBeUndefined();
  state = await queue.act("w", "s", { type: "pause", paused: true });
  await queue.act("w", "s", { type: "edit", id: item.id, token: nextToken, revision: state.revision });
  state = await queue.act("w", "s", { type: "release", id: item.id, token: nextToken });
  expect(state.paused).toBe(true);
});

test("a plain message resumes Stop even before the aborted response returns", async () => {
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const { queue } = await setup({ idle: async () => true, send: async () => { sends++; if (sends === 1) { await pending; return { pause: true, reason: "stop" }; } } });
  await queue.act("w", "s", message());
  await until(async () => sends === 1);
  await queue.act("w", "s", { type: "pause", paused: true, reason: "stop" });
  await queue.act("w", "s", message("continue"));
  expect((await queue.read("w", "s")).paused).toBe(false);
  release();
  await until(async () => { await queue.tick(); return (await queue.read("w", "s")).entries.length === 0; });
  expect(sends).toBe(2);
  await queue.act("w", "s", { type: "pause", paused: true });
  await queue.act("w", "s", message("manual pause stays"));
  expect((await queue.read("w", "s")).paused).toBe(true);
});

test("definite preparation failures remain retryable and conditional reads skip unchanged payloads", async () => {
  let fail = true;
  const { queue } = await setup({ idle: async () => true, send: async () => { if (fail) throw new QueuePreparationError("Could not restore the chat"); } });
  await queue.act("w", "s", message());
  await until(async () => (await queue.read("w", "s")).paused);
  const state = await queue.read("w", "s");
  expect(state.entries[0].status).toBe("failed");
  expect(await queue.readIfChanged("w", "s", String(state.revision))).toBeNull();
  fail = false;
  await queue.act("w", "s", { type: "pause", paused: false });
  await until(async () => (await queue.read("w", "s")).entries.length === 0);
});

test("waiting messages can be reordered during delivery without moving or resending the running prompt", async () => {
  let idle = false;
  let release = () => {};
  const delivery = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const { queue } = await setup({ idle: async () => idle, send: async (_w, _s, entry) => { sent.push(entry.id); await delivery; } });
  const a = message("running"), b = message("second"), c = message("third");
  for (const item of [a, b, c]) await queue.act("w", "s", item);
  idle = true; await queue.tick();
  await until(async () => { await queue.tick(); return (await queue.read("w", "s")).entries[0].status === "sending"; });
  const before = await queue.read("w", "s");
  await expect(queue.act("w", "s", { type: "reorder", ids: [c.id, b.id], revision: before.revision - 1 })).rejects.toThrow();
  await expect(queue.act("w", "s", { type: "reorder", ids: [c.id, c.id], revision: before.revision })).rejects.toThrow();
  await expect(queue.act("w", "s", { type: "reorder", ids: [a.id, c.id, b.id], revision: before.revision })).rejects.toThrow();
  const reordered = await queue.act("w", "s", { type: "reorder", ids: [c.id, b.id], revision: before.revision });
  expect(reordered.entries.map(item => item.id)).toEqual([a.id, c.id, b.id]);
  expect(reordered.entries[0].status).toBe("sending");
  release(); await until(async () => (await queue.read("w", "s")).entries.length === 2);
  await until(async () => { await queue.tick(); return (await queue.read("w", "s")).entries.length === 1; });
  await until(async () => { await queue.tick(); return (await queue.read("w", "s")).entries.length === 0; });
  expect(sent).toEqual([a.id, c.id, b.id]);
});
