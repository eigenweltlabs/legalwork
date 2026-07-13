import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PowerLifecycle, PowerSessions } from "./power-lifecycle.mjs";

class FakePowerSaveBlocker {
  constructor() {
    this.nextId = 1;
    this.active = new Set();
    this.startCalls = 0;
  }

  start(type) {
    assert.equal(type, "prevent-app-suspension");
    this.startCalls += 1;
    const id = this.nextId++;
    this.active.add(id);
    return id;
  }

  stop(id) {
    this.active.delete(id);
  }

  isStarted(id) {
    return this.active.has(id);
  }
}

test("PowerSessions holds one blocker across overlapping sessions", () => {
  const blocker = new FakePowerSaveBlocker();
  const sessions = new PowerSessions({ powerSaveBlocker: blocker });

  sessions.acquire("recording:a");
  sessions.acquire("dictation-paste");
  assert.equal(blocker.active.size, 1);
  assert.equal(blocker.startCalls, 1);

  sessions.release("recording:a");
  assert.equal(blocker.active.size, 1, "still one session open");

  sessions.release("dictation-paste");
  assert.equal(blocker.active.size, 0, "last release stops the blocker");
  assert.equal(sessions.isActive(), false);
});

test("PowerSessions refcounts the same key", () => {
  const blocker = new FakePowerSaveBlocker();
  const sessions = new PowerSessions({ powerSaveBlocker: blocker });

  sessions.acquire("dictation-paste");
  sessions.acquire("dictation-paste");
  sessions.release("dictation-paste");
  assert.equal(blocker.active.size, 1, "one of two acquisitions released");
  sessions.release("dictation-paste");
  assert.equal(blocker.active.size, 0);
});

test("PowerSessions restarts a blocker the OS dropped", () => {
  const blocker = new FakePowerSaveBlocker();
  const sessions = new PowerSessions({ powerSaveBlocker: blocker });

  sessions.acquire("recording:a");
  const [firstId] = [...blocker.active];
  blocker.active.clear(); // the OS terminated the power request (Modern Standby DC cap)

  sessions.acquire("recording:b");
  assert.equal(blocker.active.size, 1, "a fresh blocker was started");
  assert.notEqual([...blocker.active][0], firstId);

  sessions.releaseAll();
  assert.equal(blocker.active.size, 0);
});

test("PowerLifecycle defers resume work and cancels it on re-suspend", async () => {
  const monitor = new EventEmitter();
  const calls = [];
  const lifecycle = new PowerLifecycle({
    powerMonitor: monitor,
    settleMs: 20,
    onSuspend: () => { calls.push("suspend"); },
    onResume: () => { calls.push("resume"); },
  });
  lifecycle.start();

  monitor.emit("suspend");
  monitor.emit("resume");
  // Sleep again before the settle window elapses: the pending resume work
  // must be dropped, then the second wake reschedules it.
  monitor.emit("suspend");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, ["suspend", "suspend"]);

  monitor.emit("resume");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, ["suspend", "suspend", "resume"]);

  lifecycle.dispose();
});

test("PowerLifecycle runs unlock health check unless a resume settle is pending", async () => {
  const monitor = new EventEmitter();
  const calls = [];
  const lifecycle = new PowerLifecycle({
    powerMonitor: monitor,
    settleMs: 20,
    onResume: () => { calls.push("resume"); },
    onUnlockScreen: () => { calls.push("unlock"); },
  });
  lifecycle.start();

  monitor.emit("unlock-screen");
  assert.deepEqual(calls, ["unlock"], "plain unlock runs immediately");

  monitor.emit("resume");
  monitor.emit("unlock-screen"); // wake-then-unlock: resume settle covers it
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, ["unlock", "resume"]);

  lifecycle.dispose();
});

test("PowerLifecycle dispose stops pending resume work", async () => {
  const monitor = new EventEmitter();
  let resumed = 0;
  const lifecycle = new PowerLifecycle({
    powerMonitor: monitor,
    settleMs: 10,
    onResume: () => {
      resumed += 1;
    },
  });
  lifecycle.start();
  monitor.emit("resume");
  lifecycle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resumed, 0);
});
