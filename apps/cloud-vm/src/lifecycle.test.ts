import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lifecycle, type Runtime } from "./lifecycle.js";
import { Store, type Worker } from "./store.js";

class FakeRuntime implements Runtime {
  events: string[] = [];
  syncEnabled = false;
  checkpointOk = true;
  resumeOk = true;
  pauseOk = true;
  nextRunAt: string | null = null;
  async create(worker: Worker) { this.events.push("create:" + worker.userId); return "vm-" + worker.userId; }
  async connect(id: string) { this.events.push("connect:" + id); }
  async request(_worker: Worker, path: string) {
    this.events.push(path);
    if (path === "/cloud-sync/status") return Response.json({ enabled: this.syncEnabled, ...(this.syncEnabled ? { status: { canExecute: this.resumeOk, role: "executor", nextRunAt: this.nextRunAt } } : {}) });
    if (path.endsWith("checkpoint")) return new Response("", { status: this.checkpointOk ? 200 : 409 });
    if (path.endsWith("resume")) return new Response("", { status: this.resumeOk ? 200 : 409 });
    return new Response("", { status: 200 });
  }
  async pause(id: string) { this.events.push("pause:" + id); if (!this.pauseOk) throw new Error("disk full"); }
  async extend(id: string) { this.events.push("extend:" + id); }
}
let directory: string;
let store: Store;
let runtime: FakeRuntime;
let lifecycle: Lifecycle;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "legalwork-vms-"));
  store = new Store(join(directory, "controller.sqlite"));
  runtime = new FakeRuntime();
  lifecycle = new Lifecycle(store, runtime, "template-v1", 1000);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
async function syncedWorker() {
  const worker = await lifecycle.provision("alice");
  runtime.syncEnabled = true;
  await lifecycle.activate("alice");
  runtime.events = [];
  return worker;
}

test("concurrent provision never creates two execution owners", async () => {
  const results = await Promise.allSettled([lifecycle.provision("alice"), lifecycle.provision("alice")]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(runtime.events.filter(event => event.startsWith("create:"))).toEqual(["create:alice"]);
});
test("user mappings and independent auth survive controller restart", async () => {
  const a = await lifecycle.provision("alice"), b = await lifecycle.provision("bob");
  expect(a.sandboxId).not.toBe(b.sandboxId);
  expect(a.clientToken).not.toBe(b.clientToken);
  store.close(); store = new Store(join(directory, "controller.sqlite"));
  expect(store.get("alice")).toEqual(a);
  expect(store.get("bob")).toEqual(b);
});
test("checkpoint completes before provider pause and resume precedes routing", async () => {
  await syncedWorker();
  await lifecycle.pause("alice");
  expect(runtime.events.indexOf("/cloud-sync/checkpoint")).toBeLessThan(runtime.events.indexOf("pause:vm-alice"));
  expect(store.get("alice")?.state).toBe("paused");
  runtime.events = [];
  const acquired = await lifecycle.acquire("alice");
  expect(runtime.events).toContain("/cloud-sync/resume");
  expect(acquired.worker.state).toBe("running");
  acquired.release();
});
test("busy checkpoint leaves the microVM running", async () => {
  await syncedWorker(); runtime.checkpointOk = false;
  await expect(lifecycle.pause("alice")).rejects.toThrow("checkpoint failed");
  expect(runtime.events).not.toContain("pause:vm-alice");
  expect(store.get("alice")?.state).toBe("running");
});
test("failed provider pause releases the execution barrier", async () => {
  await syncedWorker(); runtime.pauseOk = false;
  await expect(lifecycle.pause("alice")).rejects.toThrow("disk full");
  expect(runtime.events.at(-1)).toBe("/cloud-sync/resume");
  expect(store.get("alice")?.state).toBe("running");
});
test("a restored worker with lost ownership cannot accept requests", async () => {
  await syncedWorker(); await lifecycle.pause("alice"); runtime.resumeOk = false;
  await expect(lifecycle.acquire("alice")).rejects.toThrow("routing blocked");
  expect(store.get("alice")?.state).toBe("failed");
  await expect(lifecycle.acquire("alice")).rejects.toThrow("operator recovery");
});
test("open response streams prevent pause until released", async () => {
  await lifecycle.provision("alice");
  const acquired = await lifecycle.acquire("alice");
  await expect(lifecycle.pause("alice")).rejects.toThrow("active requests");
  acquired.release(); acquired.release();
  await lifecycle.pause("alice");
  expect(store.get("alice")?.state).toBe("paused");
});
test("a paused worker wakes for its persisted scheduled run", async () => {
  await syncedWorker(); runtime.nextRunAt = new Date(Date.now() - 1000).toISOString();
  await lifecycle.pause("alice"); runtime.events = [];
  await lifecycle.tick();
  expect(store.get("alice")?.state).toBe("running");
  expect(runtime.events).toContain("/cloud-sync/resume");
});
test("provider renewal finishes before a concurrent pause", async () => {
  await lifecycle.provision("alice");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  runtime.extend = async () => {
    entered.resolve();
    await finish.promise;
    runtime.events.push("renewed");
  };
  const tick = lifecycle.tick();
  await entered.promise;
  const pause = lifecycle.pause("alice");
  await Bun.sleep(0);
  expect(runtime.events).not.toContain("pause:vm-alice");
  finish.resolve();
  await Promise.all([tick, pause]);
  expect(runtime.events.indexOf("renewed")).toBeLessThan(runtime.events.indexOf("pause:vm-alice"));
  expect(store.get("alice")?.state).toBe("paused");
});
