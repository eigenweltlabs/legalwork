import { afterEach, expect, test } from "bun:test";
import { createDocumentOwnership, type DocumentAccess } from "../src/react-app/domains/session/artifacts/document-ownership";

type Waiter = { run: () => void; cancel: () => void };
class Locks {
  held = new Set<string>();
  waiting = new Map<string, Waiter[]>();
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>): Promise<void> {
    if (options.ifAvailable && options.signal) return Promise.reject(new Error("ifAvailable cannot use signal"));
    if (options.ifAvailable && this.held.has(name)) return callback(null);
    return new Promise((resolve, reject) => {
      const entry = {
        run: () => {
          options.signal?.removeEventListener("abort", entry.cancel);
          this.held.add(name);
          void callback({ name, mode: "exclusive" }).then(resolve, reject).finally(() => {
            this.held.delete(name);
            this.waiting.get(name)?.shift()?.run();
          });
        },
        cancel: () => {
          this.waiting.set(name, (this.waiting.get(name) ?? []).filter(item => item !== entry));
          reject(new Error("Aborted"));
        },
      };
      if (options.signal?.aborted) { entry.cancel(); return; }
      if (!this.held.has(name)) entry.run();
      else { this.waiting.set(name, [...this.waiting.get(name) ?? [], entry]); options.signal?.addEventListener("abort", entry.cancel); }
    });
  }
}
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
function instance(locks: Locks, key: string, overrides: Partial<Parameters<typeof createDocumentOwnership>[0]> = {}) {
  const state: { access: DocumentAccess; refreshed: number; acquired: number; failed: number } = { access: "checking", refreshed: 0, acquired: 0, failed: 0 };
  const owner = createDocumentOwnership({
    key, locks, channel: new BroadcastChannel(`test:${key}`),
    changed: access => { state.access = access; },
    acquire: async () => { state.acquired++; },
    flush: async () => true, drain: async () => {},
    refresh: () => { state.refreshed++; }, failed: () => { state.failed++; }, ...overrides,
  });
  disposers.push(owner.dispose);
  return { owner, state };
}
test("one writer per file, separate files remain independently editable", async () => {
  const locks = new Locks(), key = crypto.randomUUID();
  const a = instance(locks, key), b = instance(locks, key), c = instance(locks, `${key}:other`);
  await until(() => a.state.access === "owner" && b.state.access === "reader" && c.state.access === "owner");
  a.owner.saved();
  await until(() => b.state.refreshed === 1);
  expect(c.state.refreshed).toBe(0);
  expect(b.owner.canWrite()).toBe(false);
});
test("handoff freezes the owner and waits for its final save before acquisition", async () => {
  const locks = new Locks(), key = crypto.randomUUID();
  let finish = (saved: boolean) => {};
  const flushed = new Promise<boolean>(resolve => { finish = resolve; });
  const a = instance(locks, key, { flush: () => flushed }), b = instance(locks, key);
  await until(() => a.state.access === "owner" && b.state.access === "reader");
  b.owner.request();
  await until(() => a.state.access === "releasing");
  expect(b.owner.canWrite()).toBe(false);
  expect(b.state.acquired).toBe(0);
  finish(true);
  await until(() => a.state.access === "reader" && b.state.access === "owner");
  expect(a.owner.canWrite()).toBe(false);
  b.owner.saved();
  await until(() => a.state.refreshed > 0);
});
test("failed save refuses handoff and keeps the original editor's ownership", async () => {
  const locks = new Locks(), key = crypto.randomUUID();
  const a = instance(locks, key, { flush: async () => false }), b = instance(locks, key);
  await until(() => a.state.access === "owner" && b.state.access === "reader");
  b.owner.request();
  await until(() => b.state.failed === 1);
  expect(a.state.access).toBe("owner");
  expect(a.owner.canWrite()).toBe(true);
  expect(b.state.acquired).toBe(0);
});
test("closing holds the lock until pending writes finish; a reader can then take it", async () => {
  const locks = new Locks(), key = crypto.randomUUID();
  let finish = () => {};
  const drained = new Promise<void>(resolve => { finish = resolve; });
  const a = instance(locks, key, { drain: () => drained }), b = instance(locks, key);
  await until(() => a.state.access === "owner" && b.state.access === "reader");
  const closed = a.owner.dispose();
  b.owner.request();
  expect(b.owner.canWrite()).toBe(false);
  finish(); await closed;
  await until(() => b.state.access === "owner");
});
test("a failed refresh never enables editing and can be retried", async () => {
  const locks = new Locks(), key = crypto.randomUUID();
  let fail = true;
  const a = instance(locks, key, { acquire: async () => { if (fail) throw new Error("offline"); } });
  await until(() => a.state.access === "unavailable");
  expect(a.owner.canWrite()).toBe(false);
  fail = false; a.owner.request();
  await until(() => a.state.access === "owner");
});
