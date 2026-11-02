import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { boundedShutdown } from "./bounded-shutdown.mjs";
import { beforeQuitRegistrations } from "../scripts/lifecycle-source.mjs";

// Execute the real main-process state/listeners without starting Electron or
// touching native windows. Native update quits close windows before before-quit.
function lifecycle() {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const stateStart = source.indexOf("let appIsQuitting = false;");
  const stateEnd = source.indexOf("let windowsCloseHintShown", stateStart);
  const closeStart = source.indexOf('mainWindow.on("close",');
  const closeEnd = source.indexOf('mainWindow.on("show",', closeStart);
  assert.ok(stateStart >= 0 && stateEnd > stateStart && closeStart >= 0 && closeEnd > closeStart);
  let hidden = false;
  const window = Object.assign(new EventEmitter(), { hide() { hidden = true; } });
  const nativeAutoUpdater = new EventEmitter();
  runInNewContext(`${source.slice(stateStart, stateEnd)}\n${source.slice(closeStart, closeEnd)}`, {
    autoUpdater: nativeAutoUpdater,
    mainWindow: window,
    keepAliveOnClose: () => true,
    systemDictation: { status: () => ({ enabled: true }) },
    appTray: { ensure() {} },
    trayShortcutLabel: () => "Control+D",
    process: { platform: "darwin" },
  });
  return {
    nativeAutoUpdater,
    close() {
      let prevented = false;
      window.emit("close", { preventDefault() { prevented = true; } });
      return { prevented, hidden };
    },
  };
}

test("closing an armed dictation window normally keeps it hidden in the background", () => {
  assert.deepEqual(lifecycle().close(), { prevented: true, hidden: true });
});

test("a native update can close an armed dictation window before app before-quit", () => {
  const app = lifecycle();
  app.nativeAutoUpdater.emit("before-quit-for-update");
  assert.deepEqual(app.close(), { prevented: false, hidden: false });
});

function quitting({ holdRecovery = false } = {}) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const disposed = [];
  /** @type {(approved: boolean) => void} */
  let approve;
  /** @type {() => void} */
  let releaseRecovery = () => {};
  let exited = false;
  /** @type {Promise<boolean>} */
  const decision = new Promise(resolve => { approve = resolve; });
  /** @type {Promise<void>} */
  const recovery = holdRecovery ? new Promise(resolve => { releaseRecovery = resolve; }) : Promise.resolve();
  const app = Object.assign(new EventEmitter(), {
    quit() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      app.emit("before-quit", event);
      if (!event.defaultPrevented) exited = true;
    },
    exit() { throw Error("Unexpected forced exit"); },
  });
  const context = {
    app, shutdownGuard: { confirm: () => decision }, shutdownApproved: false, boundedShutdown,
    appIsQuitting: false, runtimeDisposedForQuit: false, runtimeDisposeInProgress: false,
    shutdownInProgress: false, shutdownComplete: false,
    showShutdownScreen: () => disposed.push("shutdown-screen"),
    recorderServiceInstance: { dispose: () => disposed.push("recorder") },
    appAudioTap: { stop() {} }, callOverlay: { destroy() {} }, systemDictation: { dispose() {} },
    dictationHud: { destroy() {} }, meetingMonitor: { dispose() {} }, appTray: { destroy() {} }, powerSessions: { releaseAll() {} },
    mailImages: { cancel: () => { disposed.push("mail-images"); } },
    mailArtifacts: { close: async () => { disposed.push("mail-artifacts"); } },
    draftRecovery: { close: async () => { disposed.push("mail-recovery"); await recovery; } },
    uiControlServer: { stop: async () => { disposed.push("control-server"); } },
    runtimeManager: { forceStopOwnedChildren() { throw Error("Unexpected forced shutdown"); } },
    disposeRuntimeBeforeQuit: async () => { disposed.push("runtime"); context.runtimeDisposedForQuit = true; },
  };
  runInNewContext(beforeQuitRegistrations(source), context);
  return { app, disposed, approve, releaseRecovery, exited: () => exited };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test("cancelling native Quit leaves mail artifacts, recovery and workers open", async () => {
  const run = quitting();
  run.app.quit(); assert.deepEqual(run.disposed, []);
  run.approve(false); await settled();
  assert.deepEqual(run.disposed, []); assert.equal(run.exited(), false);
});

test("approved native Quit closes mail resources and workers exactly once", async () => {
  const run = quitting();
  run.app.quit(); assert.deepEqual(run.disposed, []);
  run.approve(true); await settled();
  assert.deepEqual(run.disposed, ["shutdown-screen", "recorder", "mail-images", "mail-artifacts", "mail-recovery", "runtime", "control-server"]);
  assert.equal(run.exited(), true);
});

test("a repeated Quit waits for mail recovery even after runtime disposal", async () => {
  const run = quitting({ holdRecovery: true });
  try {
    run.app.quit(); run.approve(true); await settled();
    assert.ok(run.disposed.includes("runtime")); assert.equal(run.exited(), false);
    run.app.quit();
    assert.equal(run.exited(), false, "Mail recovery must finish before native exit");
    assert.equal(run.disposed.filter(value => value === "mail-recovery").length, 1);
  } finally { run.releaseRecovery(); await settled(); }
  assert.equal(run.exited(), true);
});
