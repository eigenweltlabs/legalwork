import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { browserAbortable, createBrowserCaptureQueue } from "./browser-capture-queue.mjs";

function deferred() {
  /** @type {() => void} */
  let release = () => { throw new Error("Deferred promise is not initialized"); };
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, resolve: release };
}

const page = () => Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; } });

test("capture queues remove cancelled waiters immediately and preserve every other operation in order", async () => {
  const run = createBrowserCaptureQueue(), contents = page(), gate = deferred(), events = [];
  const first = run(contents, undefined, async () => { events.push("first"); await gate.promise; });
  const cancel = new AbortController();
  const cancelled = run(contents, cancel.signal, async () => events.push("must-not-run"));
  const third = run(contents, undefined, async () => events.push("third"));
  const reason = new Error("Cancelled while queued");
  cancel.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  assert.deepEqual(events, ["first"]);
  gate.resolve(); await Promise.all([first, third]);
  assert.deepEqual(events, ["first", "third"]);
  assert.equal(contents.listenerCount("destroyed"), 0);
});

test("active cancellation cleans before admitting the next capture, ignoring a late native completion", async () => {
  const run = createBrowserCaptureQueue(), contents = page(), native = deferred(), cancel = new AbortController(), events = [];
  const first = run(contents, cancel.signal, async signal => {
    try { await browserAbortable(() => native.promise, signal); events.push("late-old-write"); }
    finally { events.push("old-cleanup"); }
  });
  const next = run(contents, undefined, async () => events.push("new-capture"));
  cancel.abort(new Error("Stop"));
  await assert.rejects(first, /Stop/); await next;
  assert.deepEqual(events, ["old-cleanup", "new-capture"]);
  native.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["old-cleanup", "new-capture"]);
});

test("native page closure cancels active and queued capture without starting queued native work", async () => {
  const run = createBrowserCaptureQueue(), contents = page(), native = deferred();
  let cleaned = false, queued = false;
  const active = run(contents, undefined, async signal => {
    try { await browserAbortable(() => native.promise, signal); }
    finally { cleaned = true; }
  });
  const waiting = run(contents, undefined, async () => { queued = true; });
  const failures = [assert.rejects(active, /closed/), assert.rejects(waiting, /closed/)];
  contents.destroyed = true; contents.emit("destroyed");
  await Promise.all(failures);
  assert.equal(cleaned, true); assert.equal(queued, false);
  await assert.rejects(run(contents, undefined, async () => {}), /closed/);
  native.resolve();
});

test("an already cancelled capture never invokes its native operation", async () => {
  const cancel = new AbortController(); cancel.abort(new Error("Stopped before native work"));
  let called = false;
  assert.throws(() => browserAbortable(() => { called = true; }, cancel.signal), /Stopped/);
  assert.equal(called, false);
});

test("a native operation cancelling synchronously cannot evade the abort listener", async () => {
  const cancel = new AbortController(), native = deferred();
  const pending = browserAbortable(() => { cancel.abort(new Error("Synchronous native Stop")); return native.promise; }, cancel.signal);
  await assert.rejects(pending, /Synchronous native Stop/);
  native.resolve();
});

test("caller Stop is immediate while an uncancellable native screenshot retains its physical queue lease", async () => {
  const run = createBrowserCaptureQueue(), contents = page(), native = deferred();
  const activeStop = new AbortController(), waitingStop = new AbortController(), events = [];
  const first = run(contents, activeStop.signal, async signal => {
    const hide = () => events.push("caller-visibility-restored");
    signal.addEventListener("abort", hide, { once: true });
    try { events.push("native-start"); await native.promise; events.push("native-settled"); }
    finally { signal.removeEventListener("abort", hide); events.push("physical-cleanup"); }
  });
  const cancelled = run(contents, waitingStop.signal, async () => events.push("cancelled-must-not-run"));
  const next = run(contents, undefined, async () => events.push("next-native-start"));
  activeStop.abort(new Error("Active caller Stop"));
  waitingStop.abort(new Error("Queued caller Stop"));
  await assert.rejects(first, /Active caller Stop/);
  await assert.rejects(cancelled, /Queued caller Stop/);
  assert.deepEqual(events, ["native-start", "caller-visibility-restored"]);
  native.resolve(); await next;
  assert.deepEqual(events, ["native-start", "caller-visibility-restored", "native-settled", "physical-cleanup", "next-native-start"]);
  assert.equal(contents.listenerCount("destroyed"), 0);
});

test("closing a page with pending native work rejects only its waiters and leaves another page usable", async () => {
  const run = createBrowserCaptureQueue(), first = page(), second = page(), native = deferred();
  const events = [];
  const active = run(first, undefined, async () => { events.push("first-native"); await native.promise; });
  const waiting = run(first, undefined, async () => events.push("must-not-start"));
  const failures = [assert.rejects(active, /closed/), assert.rejects(waiting, /closed/)];
  first.destroyed = true; first.emit("destroyed");
  await Promise.all(failures);
  await run(second, undefined, async () => events.push("independent-native"));
  assert.deepEqual(events, ["first-native", "independent-native"]);
  native.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.listenerCount("destroyed"), 0);
  assert.equal(second.listenerCount("destroyed"), 0);
});

test("normal owner disposal closes admission synchronously before WebContents destruction", async () => {
  const run = createBrowserCaptureQueue(), contents = page(), native = deferred();
  let starts = 0;
  const active = run(contents, undefined, async () => { starts++; await native.promise; });
  const queued = run(contents, undefined, async () => starts++);
  const rejected = [assert.rejects(active, /closed/), assert.rejects(queued, /closed/)];
  run.close(contents);
  assert.equal(contents.isDestroyed(), false);
  await Promise.all(rejected);
  await assert.rejects(run(contents, undefined, async () => starts++), /closed/);
  assert.equal(starts, 1);
  native.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(contents.listenerCount("destroyed"), 0);
});
