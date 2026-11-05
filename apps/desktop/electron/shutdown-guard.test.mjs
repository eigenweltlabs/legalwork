import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createShutdownGuard } from "./shutdown-guard.mjs";

function windowFixture({ dirty = true, approve = true, fails = false } = {}) {
  const events = [];
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => events.push("restore"), show: () => events.push("show"), focus: () => events.push("focus"),
    close() { events.push("close"); window.emit("close", { preventDefault() {} }); },
    webContents: { async executeJavaScript(script) {
      events.push(script.startsWith("Boolean") ? "check" : "prompt");
      if (fails) throw new Error("renderer unavailable");
      if (script.startsWith("Boolean")) return dirty;
      if (approve) dirty = false;
      return approve;
    } },
  });
  return { window, events, markDirty: () => { dirty = true; } };
}
const guardFor = (windows, isQuitting = () => false) => createShutdownGuard({ getWindows: () => windows, isQuitting });
test("clean windows close without showing or focusing a modal", async () => {
  const { window, events } = windowFixture({ dirty: false });
  assert.equal(await guardFor([window]).confirm("close"), true);
  assert.deepEqual(events, ["check"]);
});
test("all app windows must approve before native restart", async () => {
  const first = windowFixture(), second = windowFixture({ approve: false });
  assert.equal(await guardFor([first.window, second.window]).confirm("restart"), false);
  assert.ok(first.events.includes("prompt"));
  assert.ok(second.events.includes("prompt"));
});
test("renderer failure leaves the app running", async () => {
  const { window } = windowFixture({ fails: true });
  assert.equal(await guardFor([window]).confirm("restart"), false);
});
test("close resumes only after the unsaved decision and does not recurse", async () => {
  const { window, events } = windowFixture();
  guardFor([window]).protect(window);
  let prevented = false;
  window.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(events.includes("close"), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event === "close").length, 1);
});
test("opening the unsaved file or cancelling never resumes close", async () => {
  const { window, events } = windowFixture({ approve: false });
  guardFor([window]).protect(window);
  window.emit("close", { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes("close"), false);
});
test("a concurrent close cannot reuse another window's approval", async () => {
  const first = windowFixture(), second = windowFixture();
  const guard = guardFor([first.window, second.window]);
  const pending = guard.confirm("close", [first.window]);
  assert.equal(await guard.confirm("close", [second.window]), false);
  assert.equal(await pending, true);
  assert.equal(await guard.confirm("close", [second.window]), true);
});

test("the updater awaits consent and preserves the downloaded update on cancellation", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("./updater.mjs", import.meta.url), "utf8");
  const start = source.indexOf('handleUpdater("legalwork:updater:installAndRestart",');
  const end = source.indexOf("\n  return { ensureAutoUpdater }", start);
  for (const approved of [false, true]) {
    const calls = [];
    /** @type {() => Promise<{ ok: boolean; cancelled?: boolean }>} */
    let install = async () => { throw new Error("Install handler was not registered"); };
    runInNewContext(source.slice(start, end), {
      handleUpdater: (_name, handler) => { install = handler; }, updateReady: true,
      ensureAutoUpdater: async () => ({ quitAndInstall: () => calls.push("install") }),
      beforeRestart: async () => { calls.push("consent"); return approved; },
      enableSquirrelDirectContentsWrite: async () => calls.push("prepare"),
    });
    const result = await install();
    assert.equal(result.ok, true);
    if (approved) assert.deepEqual(calls, ["consent", "prepare", "install"]);
    else { assert.equal(result.cancelled, true); assert.deepEqual(calls, ["consent"]); }
  }
});


test("new edits in an earlier window require another decision before exit", async () => {
  const first = windowFixture(), second = windowFixture();
  const execute = second.window.webContents.executeJavaScript;
  second.window.webContents.executeJavaScript = async script => {
    const answer = await execute(script);
    if (!script.startsWith("Boolean")) first.markDirty();
    return answer;
  };
  assert.equal(await guardFor([first.window, second.window]).confirm("restart"), true);
  assert.equal(first.events.filter(event => event === "prompt").length, 2);
});
