import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

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
