import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherOutputQueue } from "./output-queue.mjs";

const intent = { requestId: "request", messageId: "message", conversationId: "conversation", output: /** @type {const} */ ("insert"), originId: "old-origin" };
const ready = task => ({ ...task, state: /** @type {const} */ ("ready"), text: "Finished answer" });
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "assistant-output-"));
  const queues = [], copied = [], inserted = [];
  const path = join(root, "output.json");
  const queue = (overrides = {}) => {
    const item = new LauncherOutputQueue({ path, intervalMs: 60_000, read: async task => ready(task),
      copy: text => { copied.push(text); }, insert: async (id, text) => { inserted.push([id, text]); return { ok: false, copied: true, reason: "no-origin", message: "", origin: null }; }, ...overrides });
    queues.push(item); return item;
  };
  try { await run({ queue, path, copied, inserted }); }
  finally { await Promise.all(queues.map(item => item.dispose())); await rm(root, { recursive: true, force: true }); }
}

test("a pending output survives restart, keeps its identity and never repeats after acknowledgement", () => fixture(async ({ queue, path, copied, inserted }) => {
  const first = queue(); await first.remember(intent); await first.dispose();
  const second = queue(); await second.tick();
  assert.deepEqual(inserted, [["old-origin", "Finished answer"]]);
  assert.equal((await second.list())[0].result, "recovered");
  await second.remember(intent); await second.tick(); await second.dispose();
  const third = queue(); await third.tick(); assert.equal(inserted.length, 1); assert.equal(copied.length, 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
}));

test("a crash after an uncertain paste recovers text without pasting again", () => fixture(async ({ queue, path, copied, inserted }) => {
  await writeFile(path, JSON.stringify([{ ...intent, state: "delivering", text: "Already pasted?", createdAt: 1, updatedAt: 2 }]));
  const resumed = queue({ read: async () => { throw new Error("server offline"); } }); await resumed.tick();
  assert.deepEqual(inserted, []); assert.deepEqual(copied, ["Already pasted?"]);
  assert.equal((await resumed.list())[0].result, "recovered");
}));

test("renderer retries and concurrent polling produce a single output", () => fixture(async ({ queue, copied }) => {
  const instance = queue(); const copyIntent = { ...intent, output: "copy" };
  await Promise.all([instance.remember(copyIntent), instance.remember(copyIntent)]);
  await Promise.all([instance.tick(), instance.tick(), instance.tick()]);
  assert.deepEqual(copied, ["Finished answer"]);
  await assert.rejects(instance.remember({ ...copyIntent, messageId: "different" }), /different request/);
}));

test("cancel can win while the server is replying; a different chat's answer is never delivered", () => fixture(async ({ queue, copied, inserted }) => {
  let release = () => {}; const gate = new Promise(resolve => { release = () => resolve(undefined); });
  let began = () => {}; const started = new Promise(resolve => { began = () => resolve(undefined); });
  const instance = queue({ read: async task => { began(); await gate; return ready(task); } });
  await instance.remember(intent); const tick = instance.tick(); await started;
  await instance.cancel(intent.requestId); release(); await tick;
  assert.equal((await instance.list())[0].state, "cancelled");
  const wrong = queue({ read: async task => ({ ...ready(task), messageId: "wrong" }) });
  await wrong.remember({ ...intent, requestId: "different" }); await wrong.tick();
  assert.equal(copied.length + inserted.length, 0);
  assert.match((await wrong.list())[0].error, /does not belong/);
}));

test("clipboard failure retains the answer; malformed journals are preserved", () => fixture(async ({ queue, path }) => {
  const instance = queue({ copy: () => { throw new Error("clipboard unavailable"); } });
  await instance.remember({ ...intent, output: "copy" }); await instance.tick();
  assert.equal((await instance.list())[0].state, "failed");
  assert.equal((await instance.list())[0].text, "Finished answer");
  await instance.dispose(); await writeFile(path, "broken");
  await assert.rejects(queue().initialize()); assert.equal(await readFile(path, "utf8"), "broken");
}));

test("server downtime keeps every queued conversation until it can finish", () => fixture(async ({ queue, copied }) => {
  let offline = true;
  const instance = queue({ read: async task => { if (offline) throw new Error("offline"); return { ...ready(task), text: task.conversationId }; } });
  await instance.remember({ ...intent, output: "copy" });
  await instance.remember({ ...intent, requestId: "two", messageId: "two", conversationId: "another-chat", output: "copy" });
  await instance.tick(); assert.equal((await instance.list()).filter(task => task.state === "waiting").length, 2);
  offline = false; await instance.tick(); assert.deepEqual(copied, ["conversation", "another-chat"]);
}));
