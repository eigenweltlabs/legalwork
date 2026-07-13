import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { SystemKeyMonitor } from "./audio/system-key-monitor.mjs";

/**
 * A controllable stand-in for the spawned helper process. It never becomes
 * "ready" on its own — the test drives ready/exit explicitly so overlapping
 * lifecycle calls can be interleaved deterministically.
 */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { end() {} };
  }

  ready() {
    this.stdout.emit("data", "ready\n");
  }

  emitLine(line) {
    this.stdout.emit("data", `${line}\n`);
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0));
  }
}

function makeMonitor() {
  const children = [];
  const spawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const monitor = new SystemKeyMonitor({
    app: /** @type {any} */ ({ isPackaged: false }),
    platform: "win32",
    spawn,
    resolveExecutable: () => "fake-helper",
    restartDelaysMs: [10, 20],
    restartResetUptimeMs: 10_000,
  });
  return { monitor, children };
}

test("start resolves true and streams events once the helper is ready", async () => {
  const { monitor, children } = makeMonitor();
  const events = [];
  const startPromise = monitor.start((event) => { events.push(event); });
  assert.equal(children.length, 1);
  children[0].ready();
  assert.equal(await startPromise, true);

  children[0].emitLine("down\tControl");
  assert.deepEqual(events, [{ type: "down", key: "Control" }]);
  monitor.stop();
});

test("overlapping restart calls never strand a promise or disable a live child", async () => {
  const { monitor, children } = makeMonitor();
  const startPromise = monitor.start(() => {});
  children[0].ready();
  await startPromise;

  // Two restarts fired back-to-back (wake settle + unlock arriving together),
  // both before the first re-spawn reports ready.
  const restartA = monitor.restart();
  const restartB = monitor.restart();
  assert.equal(children.length, 3, "each restart spawned a fresh child; the prior was killed");

  // The child B (from restartA) was superseded and killed by restartB; only
  // the newest child (from restartB) should become ready.
  children[2].ready();

  const [a, b] = await Promise.all([restartA, restartB]);
  // Both promises settle — no hang.
  assert.equal(b, true, "the winning restart resolves available");
  assert.equal(typeof a, "boolean", "the superseded restart still settles");

  // The winning child is live and supervision is intact: desired stayed true,
  // so a later unexpected exit schedules a restart instead of going silent.
  assert.equal(monitor.desired, true);
  assert.equal(monitor.child, children[2], "the newest spawn owns this.child");
  monitor.stop();
});

test("a stale spawn's exit does not clear a newer spawn's start watchdog", async () => {
  const { monitor, children } = makeMonitor();
  const startPromise = monitor.start(() => {});
  children[0].ready();
  await startPromise;

  // restartA spawns child[1] (never ready). restartB supersedes it, killing
  // child[1] and spawning child[2].
  const restartA = monitor.restart();
  const restartB = monitor.restart();
  // child[1]'s async exit (from being killed) must not clear child[2]'s
  // watchdog. child[2] then becomes ready and restartB resolves true.
  await Promise.resolve();
  children[2].ready();

  assert.equal(await restartB, true);
  await restartA; // also settles
  assert.equal(monitor.desired, true);
  monitor.stop();
});

test("stop after a start supersedes the in-flight spawn and stays stopped", async () => {
  const { monitor, children } = makeMonitor();
  const startPromise = monitor.start(() => {});
  // Stop before the first child reports ready.
  monitor.stop();
  // A late ready on the killed child must not resurrect the monitor.
  children[0].ready();
  const available = await startPromise;
  assert.equal(available, false);
  assert.equal(monitor.desired, false);
  assert.equal(monitor.onEvent, null);
  assert.equal(monitor.child, null);
});

test("unexpected exit triggers a supervised restart with the same listener", async () => {
  const { monitor, children } = makeMonitor();
  const events = [];
  const startPromise = monitor.start((event) => { events.push(event); });
  children[0].ready();
  await startPromise;

  // The helper dies unexpectedly; supervision should re-spawn after the
  // backoff delay and emit a reset so chord state is rebuilt.
  children[0].emit("exit", 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 2, "supervision re-spawned the helper");
  children[1].ready();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(events.some((event) => event.type === "reset"), "a reset was emitted after re-spawn");
  monitor.stop();
});

test("exhausting restart attempts reports unavailable exactly once", async () => {
  const children = [];
  const monitor = new SystemKeyMonitor({
    app: /** @type {any} */ ({ isPackaged: false }),
    platform: "win32",
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    resolveExecutable: () => "fake-helper",
    restartDelaysMs: [5], // one retry, then give up
    restartResetUptimeMs: 10_000,
  });
  const events = [];
  const startPromise = monitor.start((event) => { events.push(event); });
  children[0].ready();
  await startPromise;

  children[0].emit("exit", 1); // first death → one retry scheduled
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(children.length, 2);
  children[1].ready();
  await new Promise((resolve) => setTimeout(resolve, 5));
  children[1].emit("exit", 1); // second death → attempts exhausted
  await new Promise((resolve) => setTimeout(resolve, 15));

  const unavailable = events.filter((event) => event.type === "unavailable");
  assert.equal(unavailable.length, 1);
  assert.equal(monitor.desired, false);
  monitor.stop();
});
