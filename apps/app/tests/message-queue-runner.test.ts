import { describe, expect, test } from "bun:test";
import { createMessageQueueRunner } from "../src/react-app/domains/session/surface/message-queue-runner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(send: (item: { id: string }) => Promise<void>, isIdle = async () => true) {
  const state = { items: [{ id: "first" }, { id: "second" }], paused: false, errors: 0, drained: 0 };
  const runner = createMessageQueueRunner({
    next: () => state.items[0],
    paused: () => state.paused,
    isIdle,
    take: (item) => { state.items = state.items.filter((entry) => entry.id !== item.id); },
    send,
    failed: (_error, item) => { state.paused = true; state.errors++; if (item) state.items.unshift(item); },
    drained: () => { state.drained++; },
  });
  return { state, runner };
}

describe("session message queue", () => {
  test("waits for the entire turn, sends FIFO, and cannot double-drain", async () => {
    const firstTurn = deferred<void>();
    const started = deferred<void>();
    const sent: string[] = [];
    const { state, runner } = fixture(async (item) => {
      sent.push(item.id);
      if (item.id === "first") { started.resolve(); await firstTurn.promise; }
    });
    const running = runner.wake();
    await started.promise;
    await runner.wake(); // repeated SSE, re-renders and status polling
    expect(sent).toEqual(["first"]);
    expect(state.items).toEqual([{ id: "second" }]);
    firstTurn.resolve();
    await running;
    expect(sent).toEqual(["first", "second"]);
    expect(state.drained).toBe(1);
  });

  test("busy, retry, and approval waits do not send", async () => {
    let idle = false;
    const sent: string[] = [];
    const { runner } = fixture(async (item) => { sent.push(item.id); }, async () => idle);
    await runner.wake();
    await runner.wake();
    expect(sent).toEqual([]);
    idle = true;
    await runner.wake();
    expect(sent).toEqual(["first", "second"]);
  });

  test("stop pauses remaining messages without deleting them", async () => {
    const done = deferred<void>();
    const started = deferred<void>();
    const { state, runner } = fixture(async () => { started.resolve(); await done.promise; });
    const running = runner.wake();
    await started.promise;
    state.paused = true;
    done.resolve();
    await running;
    expect(state.items).toEqual([{ id: "second" }]);
    expect(state.drained).toBe(0);
  });

  test("failure restores the failed message and pauses, without retry loops", async () => {
    const { state, runner } = fixture(async () => { throw new Error("offline"); });
    await runner.wake();
    await runner.wake();
    expect(state.items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(state.paused).toBe(true);
    expect(state.errors).toBe(1);
  });

  test("editing or removing a message during the status check never sends it", async () => {
    const checked = deferred<boolean>();
    const sent: string[] = [];
    const { state, runner } = fixture(async (item) => { sent.push(item.id); }, () => checked.promise);
    const running = runner.wake();
    state.items.shift();
    checked.resolve(true);
    await running;
    expect(sent).toEqual(["second"]);
  });

  test("separate sessions do not block or consume one another", async () => {
    const done = deferred<void>();
    const a = fixture(async () => { await done.promise; });
    const b = fixture(async () => {});
    const runningA = a.runner.wake();
    await b.runner.wake();
    expect(b.state.items).toEqual([]);
    expect(a.state.items.length).toBe(1);
    done.resolve();
    await runningA;
  });

  test("reordering during the idle check sends the new order", async () => {
    const checked = deferred<boolean>();
    const sent: string[] = [];
    const { state, runner } = fixture(async (item) => { sent.push(item.id); }, () => checked.promise);
    const running = runner.wake();
    state.items.reverse();
    checked.resolve(true);
    await running;
    expect(sent).toEqual(["second", "first"]);
  });

  test("an edit saved during the idle check sends the replacement, never stale content", async () => {
    const checked = deferred<boolean>();
    const sent: { id: string }[] = [];
    const { state, runner } = fixture(async (item) => { sent.push(item); }, () => checked.promise);
    const running = runner.wake();
    const replacement = { id: "first", text: "edited message" };
    state.items[0] = replacement;
    checked.resolve(true);
    await running;
    expect(sent[0]).toBe(replacement);
    expect(sent.map((item) => item.id)).toEqual(["first", "second"]);
  });
});
