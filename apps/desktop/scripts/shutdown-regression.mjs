// Real Electron beforeunload + production React dialog and workflow draft store.
// Native installation is simulated; no installed app or real profile is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { boundedShutdown } from "../electron/bounded-shutdown.mjs";
import { createShutdownGuard } from "../electron/shutdown-guard.mjs";
import { beforeQuitRegistrations } from "./lifecycle-source.mjs";
const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.env.LEGALWORK_SHUTDOWN_TEST_OUTPUT;
if (!process.versions.electron) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-shutdown-"));
  const appRoot = fileURLToPath(new URL("../../app/", import.meta.url));
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const { build } = appRequire("esbuild");
  const result = await build({ entryPoints: [path.join(appRoot, "tests/fixtures/shutdown-dialog.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.join(appRoot, "tsconfig.json"), define: { "import.meta.env": "{}", "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.hot": "undefined", "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".css": "empty" }, logLevel: "silent" });
  const assets = path.join(appRoot, "dist/assets");
  const cssFiles = (await readdir(assets)).filter(name => /^(app|index)-.*\.css$/.test(name));
  assert.ok(cssFiles.length, "Run pnpm --filter @legalwork/app build first");
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(result.outputFiles[0].text); return; }
      if (request.url.startsWith("/assets/")) {
        const name = path.basename(request.url); response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "application/octet-stream"); response.end(await readFile(path.join(assets, name))); return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html lang="en" data-theme="light"><head>${cssFiles.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join("")}</head><body class="bg-background"><script src="/fixture.js"></script></body></html>`);
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    if (output) await mkdir(output, { recursive: true });
    const binary = process.env.LEGALWORK_ELECTRON_BINARY ?? (await import("electron")).default;
    const child = spawn(binary, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, LEGALWORK_SHUTDOWN_PROFILE: root, LEGALWORK_SHUTDOWN_FIXTURE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const [code, signal] = await once(child, "exit"); clearTimeout(timeout);
    assert.equal(code, 0, `Electron regression failed (${signal ?? code}): ${log}`);
    console.log(log.trim());
  } finally { server.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setName("LegalWork Unsaved Changes Verification"); app.setPath("userData", process.env.LEGALWORK_SHUTDOWN_PROFILE);
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.on("window-all-closed", () => {});
  const results = [];
  app.whenReady().then(async () => {
    const waitFor = async (window, expression) => {
      for (let i = 0; i < 150; i++) { if (await window.webContents.executeJavaScript(expression)) return; await delay(20); }
      throw new Error(`Timed out: ${expression}`);
    };
    const fixture = async (options = {}) => {
      const window = new BrowserWindow({ show: false, focusable: false, width: options.width ?? 1000, height: 680, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
      window.show = () => {}; window.focus = () => {};
      let quitting = false, blocked = 0;
      window.webContents.on("will-prevent-unload", () => { blocked++; });
      const guard = createShutdownGuard({ getWindows: () => [window], isQuitting: () => quitting });
      if (!options.baseline) guard.protect(window);
      await window.loadURL(process.env.LEGALWORK_SHUTDOWN_FIXTURE_URL);
      await waitFor(window, "Boolean(window.shutdownFixture)");
      await window.webContents.executeJavaScript(`window.shutdownFixture.setup(${JSON.stringify(options)})`);
      const click = label => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`, true);
      const state = () => window.webContents.executeJavaScript("window.shutdownFixture.state()");
      const restart = () => guard.confirm("restart");
      const install = async approved => { if (approved) { quitting = true; window.close(); await delay(80); assert.ok(window.isDestroyed()); } };
      const modal = () => waitFor(window, 'Boolean(document.querySelector("[role=dialog]"))');
      return { window, guard, click, state, restart, install, modal, blocked: () => blocked, setQuitting: value => { quitting = value; } };
    };
    let item = await fixture({ baseline: true });
    item.window.close(); await delay(100);
    assert.equal(item.window.isDestroyed(), false); assert.equal(item.blocked(), 1);
    assert.equal(await item.window.webContents.executeJavaScript('Boolean(document.querySelector("[role=dialog]"))'), false);
    results.push("baseline: dirty workflow silently blocks native close"); item.window.destroy();

    item = await fixture(); let decision = item.restart(); await item.modal();
    assert.ok(await item.window.webContents.executeJavaScript('document.querySelector("[role=dialog]").textContent.includes("Arbeitsvertragsprüfung (Standard-Check)")'));
    if (output) await delay(250);
    if (output) await writeFile(path.join(output, "restart-unsaved-en.png"), (await item.window.webContents.capturePage()).toPNG());
    await item.click("Open unsaved file"); assert.equal(await decision, false); assert.equal(item.window.isDestroyed(), false); await waitFor(item.window, 'window.shutdownFixture.state().route === "/workspace/test/settings/workflows"'); assert.equal((await item.state()).opened, 1);
    decision = item.restart(); await item.modal();
    assert.equal(await item.window.webContents.executeJavaScript('document.querySelector("[role=dialog]").textContent.includes("Open unsaved file")'), false);
    await item.click("Save and restart"); assert.equal(await decision, true);
    let saved = await item.state(); assert.equal(saved.writes, 1); assert.ok(saved.disk.includes("Unsaved test edits.")); assert.deepEqual(saved.dirty, []);
    await item.install(true); results.push("open file cancels restart; visible file hides Open; save persists before native restart");

    item = await fixture({ extraMarkdown: true }); decision = item.restart(); await item.modal();
    await item.click("Save and restart"); assert.equal(await decision, true); saved = await item.state(); assert.deepEqual(saved.dirty, []); assert.equal(saved.markdown, saved.markdownBaseline);
    await item.install(true); results.push("all workflow and Markdown drafts save before restart");

    item = await fixture({ failure: true }); decision = item.restart(); await item.modal();
    await item.click("Save and restart"); await waitFor(item.window, 'Boolean(document.querySelector("[role=alert]"))');
    assert.equal(item.window.isDestroyed(), false); assert.equal((await item.state()).writes, 0); assert.equal((await item.state()).dirty.length, 1);
    await item.window.webContents.executeJavaScript('document.querySelector("[role=dialog] button[data-slot=dialog-close]").click()', true);
    assert.equal(await decision, false); assert.equal((await item.state()).dirty.length, 1); item.window.destroy(); results.push("failed save retains draft; cancelling leaves app usable");

    item = await fixture({ language: "de" }); decision = item.restart(); await item.modal();
    if (output) await delay(250);
    if (output) await writeFile(path.join(output, "restart-unsaved-de.png"), (await item.window.webContents.capturePage()).toPNG());
    await item.click("Verwerfen und neu starten"); assert.equal(await decision, true); saved = await item.state(); assert.equal(saved.writes, 0); assert.ok(!saved.disk.includes("Unsaved test edits."));
    await item.install(true); results.push("discard restarts without saving; German labels render");

    for (const width of [640, 440]) {
      item = await fixture({ language: "de", width }); decision = item.restart(); await item.modal();
      await delay(250);
      const layout = await item.window.webContents.executeJavaScript(`(() => {
        const footer = document.querySelector('[role="dialog"] [data-slot="dialog-footer"]');
        const boundary = footer.getBoundingClientRect();
        return { left: boundary.left, right: boundary.right, buttons: [...footer.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { left: rect.left, right: rect.right, center: rect.top + rect.height / 2, fits: button.scrollWidth <= button.clientWidth + 1 };
        }) };
      })()`);
      assert.equal(layout.buttons.length, 3);
      for (const button of layout.buttons) {
        assert.ok(button.left >= layout.left && button.right <= layout.right, `Action clipped at window width ${width}`);
        assert.ok(button.fits, `Action text clipped at window width ${width}`);
        assert.ok(Math.abs(button.center - layout.buttons[0].center) < 1, "Actions must remain in one row");
      }
      await item.click("Verwerfen und neu starten"); assert.equal(await decision, true); await item.install(true);
    }
    results.push("German actions remain in one row without clipping at 640px and 440px");

    item = await fixture(); item.window.close(); await item.modal();
    await item.click("Discard and close"); await delay(100); assert.equal(item.window.isDestroyed(), true); results.push("native window Close shows close labels and resumes after discard");

    item = await fixture({ clean: true }); assert.equal(await item.restart(), true); await item.install(true); results.push("clean shutdown skips modal");
    // Run the app's actual before-quit handler with real Electron app.quit().
    // Runtime disposal is synthetic so this never stops the installed app's workers.
    item = await fixture();
    const disposed = [];
    const source = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
    const context = {
      app, shutdownGuard: item.guard, shutdownApproved: false, boundedShutdown,
      shutdownInProgress: false, shutdownComplete: false,
      set appIsQuitting(value) { item.setQuitting(value); },
      runtimeDisposedForQuit: false, runtimeDisposeInProgress: false,
      showShutdownScreen: () => disposed.push("shutdown-screen"),
      recorderServiceInstance: { dispose: () => disposed.push("recorder") },
      appAudioTap: { stop: () => {} }, callOverlay: { destroy: () => {} }, systemDictation: { dispose: () => {} },
      dictationHud: { destroy: () => {} }, meetingMonitor: { dispose: () => {} }, appTray: { destroy: () => {} }, powerSessions: { releaseAll: () => {} },
      uiControlServer: { stop: async () => {} }, runtimeManager: { forceStopOwnedChildren() {} },
      mailImages: { cancel: () => { disposed.push("mail-images"); } },
      mailArtifacts: { close: async () => { disposed.push("mail-artifacts"); } },
      draftRecovery: { close: async () => { disposed.push("mail-recovery"); } },
      disposeRuntimeBeforeQuit: async () => {
        const saved = await item.state();
        assert.equal(saved.writes, 1); assert.deepEqual(saved.dirty, []);
        disposed.push("runtime"); context.runtimeDisposedForQuit = true;
      },
    };
    runInNewContext(beforeQuitRegistrations(source), context);
    app.quit(); await item.modal(); assert.deepEqual(disposed, []);
    await item.window.webContents.executeJavaScript('document.querySelector("[role=dialog] button[data-slot=dialog-close]").click()', true);
    await delay(50); assert.deepEqual(disposed, []); assert.equal(item.window.isDestroyed(), false);
    app.on("will-quit", () => {
      try {
        assert.equal(item.window.isDestroyed(), true);
        assert.deepEqual(disposed, ["shutdown-screen", "recorder", "mail-images", "mail-artifacts", "mail-recovery", "runtime"]);
        results.push("normal app Quit waits for consent, survives cancellation, and saves before disposal");
        for (const result of results) console.log(`PASS ${result}`);
        if (output) writeFileSync(path.join(output, "results.json"), JSON.stringify({ electron: process.versions.electron, results }, null, 2));
      } catch (error) { console.error(error.stack); app.exit(1); }
    });
    app.quit(); await item.modal(); await item.click("Save and close");
  }).catch(error => { console.error(error.stack); app.exit(1); });
}
