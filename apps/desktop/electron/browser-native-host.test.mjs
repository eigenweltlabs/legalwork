import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBrowserCaptureQueue } from "./browser-capture-queue.mjs";
import { createOwnedBrowserCapture } from "./browser-native-host.mjs";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBrowserProject } from "./browser-project.mjs";
import { reserveDownload } from "./browser-downloads.mjs";
import { fileURLWithin } from "./browser-native/runtime/policy.mjs";

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

test("local browser ownership survives offline content; downloads require its existing root and file access stays scoped", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "browser-offline-content-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const engine = path.join(root, "engine"), content = path.join(root, "content"); await mkdir(engine);
  const state = { selectedId: "matter", workspaces: [{ id: "matter", workspaceType: "local", path: engine, contentPath: content }] };
  const context = { workspaceId: "matter" }, server = { running: false };
  assert.equal(await resolveBrowserProject(context, state, server, "", "engine"), engine);
  assert.equal(await resolveBrowserProject(context, state, server, ""), content);
  assert.throws(() => reserveDownload(content, "contract.pdf"), /ENOENT/);
  assert.equal(await stat(content).catch(() => null), null);
  await mkdir(content);
  const saved = reserveDownload(content, "contract.pdf");
  assert.equal(saved.path, path.join(content, "Downloads", "contract.pdf"));
  const html = pathToFileURL(path.join(content, "document.html")).href;
  assert.equal(fileURLWithin(html, [engine, content]), true);
  assert.equal(fileURLWithin(html, [engine]), false);
  assert.equal(fileURLWithin(html, []), false);
  assert.equal(fileURLWithin(pathToFileURL(path.join(root, "other", "document.html")).href, [engine, content]), false);
  assert.equal(fileURLWithin("file://server/share/matter/document.html", ["\\\\server\\share\\matter"]), true);
  assert.equal(fileURLWithin("file://other/share/matter/document.html", ["\\\\server\\share\\matter"]), false);
});
