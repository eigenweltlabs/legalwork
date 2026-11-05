import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBrowserCaptureQueue } from "./browser-capture-queue.mjs";
import { createOwnedBrowserCapture } from "./browser-native-host.mjs";

function deferred() {
  /** @type {() => void} */
  let release = () => { throw new Error("Deferred promise is not initialized"); };
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, resolve: release };
}

test("native embed disposal or owner replacement during authorization cannot start a capture", async () => {
  for (const replace of [false, true]) {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const owners = new WeakMap(), context = { sessionId: "exact-chat" };
    const entry = { closed: false, context, owner: { isDestroyed: () => false } };
    owners.set(contents, entry);
    const authorizing = deferred(), allowed = deferred();
    const checked = deferred();
    let starts = 0;
    const capture = createOwnedBrowserCapture(createBrowserCaptureQueue(), owners, async actual => {
      assert.equal(actual, context);
      authorizing.resolve();
      await allowed.promise;
      checked.resolve();
    });
    // Embed captures have no original signal; the queue's signal is decisive.
    const pending = capture(contents, undefined, async () => { starts++; });
    const refused = assert.rejects(pending, /closed/);
    await authorizing.promise;
    if (replace) owners.set(contents, { ...entry, context: { sessionId: "different-chat" } });
    else capture.close(contents);
    allowed.resolve();
    await checked.promise;
    await refused;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.closed, false);
    assert.equal(contents.isDestroyed(), false);
    assert.equal(starts, 0);
    assert.equal(contents.listenerCount("destroyed"), 0);
  }
});

test("native capture receives the queue signal and reauthorizes a queued owner", async () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const owners = new WeakMap(), context = { sessionId: "exact-chat" };
  owners.set(contents, { closed: false, context, owner: { isDestroyed: () => false } });
  const native = deferred(), started = deferred();
  const stop = new AbortController();
  let checks = 0, dispatches = 0, revoked = false;
  const capture = createOwnedBrowserCapture(createBrowserCaptureQueue(), owners, async actual => {
    assert.equal(actual, context); checks++;
    if (revoked) throw new Error("Exact owner permission revoked");
  });
  const active = capture(contents, stop.signal, async signal => {
    assert.notEqual(signal, stop.signal);
    dispatches++; started.resolve();
    await native.promise;
    assert.equal(signal.aborted, true);
  });
  const stopped = assert.rejects(active, /Caller Stop/);
  await started.promise;
  const queued = capture(contents, undefined, async () => { dispatches++; });
  const denied = assert.rejects(queued, /permission revoked/);
  stop.abort(new Error("Caller Stop"));
  await stopped;
  assert.equal(checks, 1);
  revoked = true; native.resolve();
  await denied;
  assert.equal(checks, 2);
  assert.equal(dispatches, 1);
});
