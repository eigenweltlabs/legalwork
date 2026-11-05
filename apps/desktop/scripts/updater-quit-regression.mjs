// Real Electron windows and app shutdown, with only the native update request
// simulated. No installed app, updater cache, microphone or desktop UI is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.versions.electron) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-update-quit-"));
  const binary = process.env.LEGALWORK_ELECTRON_BINARY ?? (await import("electron")).default;
  const cases = [
    ...(process.env.LEGALWORK_QUIT_TEST_BASELINE ? [{ name: "before-fix", source: process.env.LEGALWORK_QUIT_TEST_BASELINE, blocked: true }] : []),
    { name: "fixed", source: fileURLToPath(new URL("../electron/main.mjs", import.meta.url)), blocked: false },
  ];
  const results = [];
  try {
    for (const item of cases) {
      const report = path.join(root, `${item.name}.json`);
      const child = spawn(binary, [script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, LEGALWORK_QUIT_TEST_ROOT: root, LEGALWORK_QUIT_TEST_SOURCE: item.source, LEGALWORK_QUIT_TEST_REPORT: report, LEGALWORK_QUIT_TEST_BLOCKED: String(item.blocked) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        const [code, signal] = await once(child, "exit");
        assert.equal(code, 0, `${item.name} failed (${signal ?? code}): ${output}`);
        const result = JSON.parse(await readFile(report, "utf8"));
        results.push({ ...result, processExited: true, exitCode: code, exitKind: item.blocked ? "test-cleanup-after-blocked-update" : "normal-app-quit" });
        console.log(`PASS ${item.name}: ${JSON.stringify(results.at(-1))}`);
      } finally { clearTimeout(timeout); }
    }
    if (process.env.LEGALWORK_QUIT_TEST_OUTPUT) await writeFile(process.env.LEGALWORK_QUIT_TEST_OUTPUT, `${JSON.stringify(results, null, 2)}\n`);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
} else {
  const { app, autoUpdater, BrowserWindow, ipcMain } = await import("electron");
  const blocked = process.env.LEGALWORK_QUIT_TEST_BLOCKED === "true";
  const root = process.env.LEGALWORK_QUIT_TEST_ROOT;
  app.setName("LegalWork Update Quit Verification");
  app.setPath("userData", path.join(root, blocked ? "before-profile" : "fixed-profile"));
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.on("window-all-closed", () => {});
  const events = [];
  const disposed = [];
  let focused = false;
  let normalClosePrevented = false;
  const report = () => ({ electron: process.versions.electron, pid: process.pid, expectedBlocked: blocked, normalClosePrevented, focused, events, disposed });
  const save = () => writeFileSync(process.env.LEGALWORK_QUIT_TEST_REPORT, JSON.stringify(report()));
  const fail = error => { console.error(error); app.exit(1); };
  app.whenReady().then(async () => {
    const server = createServer((_request, response) => response.end('<!doctype html><title>Update quit verification</title><button id="install" onclick="window.verification.install()">Install</button>'));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const preload = path.join(root, "verification-preload.cjs");
    await writeFile(preload, 'const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("verification", { install: () => ipcRenderer.send("verification:install") });');
    const window = new BrowserWindow({ show: false, focusable: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.on("focus", () => { focused = true; });
    window.on("closed", () => events.push("window-closed"));
    app.on("before-quit", () => events.push("before-quit"));
    const source = await readFile(process.env.LEGALWORK_QUIT_TEST_SOURCE, "utf8");
    const section = (start, end) => {
      const from = source.indexOf(start), to = source.indexOf(end, from);
      assert.ok(from >= 0 && to > from, `Missing lifecycle section ${start}`);
      return source.slice(from, to);
    };
    const context = {
      app, autoUpdater, mainWindow: window, process,
      keepAliveOnClose: () => true,
      systemDictation: { status: () => ({ enabled: true }), dispose: () => disposed.push("dictation") },
      appTray: { ensure() {}, destroy: () => disposed.push("tray") },
      trayShortcutLabel: () => "Control+D",
      runtimeDisposedForQuit: false, runtimeDisposeInProgress: false,
      showShutdownScreen: () => disposed.push("shutdown-screen"),
      recorderServiceInstance: { dispose: () => disposed.push("recorder") },
      appAudioTap: { stop: () => disposed.push("audio") },
      callOverlay: { destroy: () => disposed.push("overlay") },
      dictationHud: { destroy: () => disposed.push("hud") },
      meetingMonitor: { dispose: () => disposed.push("meeting") },
      powerSessions: { releaseAll: () => disposed.push("power") },
      uiControlServer: { stop: async () => disposed.push("control-server") },
      disposeRuntimeBeforeQuit: async () => {
        context.runtimeDisposeInProgress = true;
        await delay(10);
        disposed.push("runtime");
        context.runtimeDisposedForQuit = true;
        context.runtimeDisposeInProgress = false;
      },
    };
    runInNewContext([
      section("let appIsQuitting = false;", "let windowsCloseHintShown"),
      section('mainWindow.on("close",', 'mainWindow.on("show",'),
      section('app.on("before-quit",', 'app.on("second-instance",'),
    ].join("\n"), context);
    window.on("close", event => events.push(event.defaultPrevented ? "close-prevented" : "close-allowed"));
    await window.loadURL(`http://127.0.0.1:${server.address().port}`);
    window.close();
    normalClosePrevented = !window.isDestroyed() && events.at(-1) === "close-prevented";
    assert.equal(normalClosePrevented, true, "Ordinary close must keep dictation alive");
    events.length = 0;
    const closed = once(window, "closed");
    const clicked = new Promise(resolve => ipcMain.once("verification:install", () => {
      events.push("install-click");
      autoUpdater.emit("before-quit-for-update");
      events.push("before-quit-for-update");
      window.close();
      resolve();
    }));
    void window.webContents.executeJavaScript('document.getElementById("install").click()').catch(error => { if (!window.isDestroyed()) fail(error); });
    await clicked;
    assert.equal(focused, false, "The verification window must never take focus");
    if (blocked) {
      await delay(100);
      assert.equal(window.isDestroyed(), false, "The old handler must reproduce the blocked update");
      assert.ok(events.includes("close-prevented"));
      assert.equal(events.includes("before-quit"), false);
      assert.deepEqual(disposed, []);
      save();
      window.destroy();
      server.close();
      app.exit(0);
    } else {
      await Promise.race([closed, delay(3000).then(() => { throw new Error("Update did not close the Electron window"); })]);
      assert.equal(window.isDestroyed(), true, "Update installation must close the real Electron window");
      assert.equal(events.includes("before-quit"), false, "Native updates close windows before app quit");
      app.on("will-quit", () => {
        try {
          events.push("will-quit");
          assert.equal(disposed.filter(value => value === "runtime").length, 1);
          assert.equal(disposed.filter(value => value === "recorder").length, 1);
          assert.ok(events.indexOf("window-closed") < events.indexOf("before-quit"));
          save();
          server.close();
        } catch (error) { fail(error); }
      });
      app.quit();
    }
  }).catch(fail);
}
