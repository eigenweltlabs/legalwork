import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.versions.electron) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-autofill-"));
  const appRoot = fileURLToPath(new URL("../../app/", import.meta.url));
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const { createServer: viteServer } = await import(pathToFileURL(appRequire.resolve("vite")));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; probe.close(); await once(probe, "close");
  const vite = await viteServer({ root: appRoot, server: { host: "127.0.0.1", port, strictPort: true }, logLevel: "error" });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const { build } = appRequire("esbuild");
  const serverRoot = fileURLToPath(new URL("../../server/src/", import.meta.url));
  const storeModule = path.join(root, "store.mjs");
  await build({ stdin: { contents: 'export { BrowserPasswordStore } from "./browser-passwords.ts"; export { OAuthVault } from "./file-storage/oauth/vault.ts";', resolveDir: serverRoot }, bundle: true, platform: "node", format: "esm", outfile: storeModule, logLevel: "silent" });
  try {
    const binary = (await import("electron")).default;
    const child = spawn(binary, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, LEGALWORK_AUTOFILL_PROFILE: root, LEGALWORK_AUTOFILL_UI: url, LEGALWORK_AUTOFILL_STORE: storeModule }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
    const [code, signal] = await once(child, "exit"); clearTimeout(timeout);
    assert.equal(code, 0, `Autofill regression failed (${signal ?? code}): ${log}`);
    console.log(log.trim());
  } finally { await vite.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
} else {
  const { app, BrowserWindow, BaseWindow, WebContentsView, clipboard, session, ipcMain } = await import("electron");
  const { BROWSER_PRELOAD_CHANNELS, createBrowserPanel } = await import("../electron/browser-panel.mjs");
  const { createAppUrlMatcher, guardIpcMain } = await import("../electron/app-url.mjs");
  const { BrowserPasswordStore, OAuthVault } = await import(pathToFileURL(process.env.LEGALWORK_AUTOFILL_STORE));
  const root = process.env.LEGALWORK_AUTOFILL_PROFILE;
  app.setName("LegalWork Autofill Verification"); app.setPath("userData", path.join(root, "profile"));
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
  const site = createServer((request, response) => {
    const mode = request.url;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><style>body{font:16px system-ui;margin:60px;background:#fafafa}form{width:320px;padding:28px;border:1px solid #ddd;border-radius:14px;background:white}input{display:block;width:100%;box-sizing:border-box;padding:12px;margin:8px 0 20px}button{padding:10px}</style><h1>Example Client Portal</h1><form onsubmit="event.preventDefault();window.submitted=true"><label>Email<input name="username" autocomplete="username"></label>${mode === '/username' ? '' : '<label>Password<input name="password" type="password" autocomplete="' + (mode === '/signup' ? 'new-password' : 'current-password') + '"></label>'}<button>Sign in</button></form><input id="hidden" type="password" style="display:none"><input id="otp" autocomplete="one-time-code">`);
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const website = `http://127.0.0.1:${site.address().port}`;
  const vault = new OAuthVault(path.join(root, "saved-logins.vault"));
  let store = new BrowserPasswordStore(vault);
  await store.save({ label: "Work account", origin: website, username: "lawyer@example.org", password: "synthetic-work-password" });
  await store.save({ label: "Personal account", origin: website, username: "personal@example.org", password: "synthetic-personal-password" });
  await store.save({ label: "Other site", origin: "https://unrelated.example", username: "unrelated", password: "unrelated-password" });
  store = new BrowserPasswordStore(new OAuthVault(vault.path));
  const window = new BrowserWindow({ width: 960, height: 740, show: false });
  await window.loadURL(process.env.LEGALWORK_AUTOFILL_UI + "/overlay.html");
  const handlers = new Map();
  const trace = [];
  const panel = createBrowserPanel({ app, BaseWindow, WebContentsView, clipboard, session,
    getWindow: () => window, getWindowForEvent: () => window,
    authorizeBrowserAutomation: async () => {}, loadBrowserPasswords: async () => store,
    isAllowedAppNavigation: () => true, safeOpen: { openExternal: async () => false }, resolveDownloadDirectory: async () => null });
  panel.registerIpc(guardIpcMain({ handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => ipcMain.on(name, (event, ...args) => {
    trace.push({ name, focused: window.isFocused(), page: event.sender.getURL() });
    callback(event, ...args);
  }) }, {
    isTrustedUrl: createAppUrlMatcher({ devServerUrl: process.env.LEGALWORK_AUTOFILL_UI, appRoot: root }),
    openChannels: BROWSER_PRELOAD_CHANNELS,
    onRejected: channel => trace.push({ rejected: channel }),
  }));
  const invoke = (name, ...args) => handlers.get(`legalwork:browser:${name}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  const until = async (predicate, label) => { for (let i = 0; i < 160; i++) { if (await predicate()) return; await delay(50); } throw new Error(`Timed out: ${label}; recent events: ${JSON.stringify(trace.slice(-12))}`); };
  let status = 0;
  let releaseCredentialRead = () => {};
  try {
    const { tabId } = await invoke("createTab", website);
    invoke("show", { x: 0, y: 0, width: 960, height: 710 }, tabId);
    const browser = window.contentView.children.at(-1);
    await until(() => browser.webContents.getURL() === website + "/" && !browser.webContents.isLoading(), "fixture navigation");
    window.show(); window.focus(); browser.webContents.focus();
    await until(() => window.isFocused(), "focused test window");
    const popup = () => window.contentView.children.find(view => view !== browser && view.webContents !== window.webContents);
    const focus = async selector => {
      if (process.platform === "darwin") app.focus({ steal: true });
      window.focus();
      await until(() => window.isFocused(), "active test window");
      browser.webContents.focus();
      await until(() => browser.webContents.isFocused(), "browser keyboard focus");
      await browser.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const point = await browser.webContents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+10),y:Math.round(r.y+10)}})()`);
      browser.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      browser.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      await until(() => popup(), "saved login picker");
      await until(() => popup()?.webContents.executeJavaScript("document.body.textContent.includes('Work account')"), "account choices");
    };
    const choose = async (name, username) => {
      const overlay = popup();
      await overlay.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify(name)})).click()`);
      await until(() => !popup(), "picker closes");
      await until(async () => await browser.webContents.executeJavaScript("document.querySelector('[name=username]').value") === username, "selected username filled");
    };
    await focus('[name="username"]');
    const text = await popup().webContents.executeJavaScript("document.body.textContent");
    assert.ok(text.includes("lawyer@example.org") && text.includes("personal@example.org"));
    assert.ok(!text.includes("Other site") && !text.includes("synthetic-work-password"));
    assert.equal(await browser.webContents.executeJavaScript("document.body.textContent.includes('Work account')"), false);
    const output = process.env.LEGALWORK_AUTOFILL_TEST_OUTPUT;
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "saved-login-suggestions.png"), (await popup().webContents.capturePage()).toPNG());
      await writeFile(path.join(output, "login-page.png"), (await browser.webContents.capturePage()).toPNG());
    }
    await choose("Personal account", "personal@example.org");
    assert.deepEqual(await browser.webContents.executeJavaScript("[document.querySelector('[name=username]').value,document.querySelector('[name=password]').value,Boolean(window.submitted)]"), ["personal@example.org", "synthetic-personal-password", false]);
    console.log("PASS: real persisted vault, matching multi-account picker, username/password fill, no submission or secret in picker");
    await browser.webContents.loadURL(website + "/username");
    await focus('[name="username"]'); await choose("Work account", "lawyer@example.org");
    assert.equal(await browser.webContents.executeJavaScript("document.querySelector('[name=username]').value"), "lawyer@example.org");
    await browser.webContents.loadURL(website + "/password");
    await focus('[name="password"]');
    // A vault read can outlast native focus returning from the picker. Hold it
    // so this ordering is exercised deterministically rather than by CI timing.
    const getSaved = store.get.bind(store);
    let readingCredential = false;
    const credentialRead = new Promise(resolve => { releaseCredentialRead = resolve; });
    store.get = async id => { readingCredential = true; await credentialRead; return getSaved(id); };
    browser.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    await until(() => popup()?.webContents.executeJavaScript("document.activeElement.tagName === 'BUTTON'"), "keyboard selection");
    popup().webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    popup().webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await until(() => readingCredential && !popup(), "selected credential read");
    browser.webContents.focus();
    await browser.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    releaseCredentialRead();
    await delay(200);
    await until(async () => await browser.webContents.executeJavaScript("document.querySelector('[name=password]').value") === "synthetic-work-password", "keyboard fill");
    assert.equal(popup(), undefined);
    store.get = getSaved;
    console.log("PASS: username-first and keyboard-selected password steps");
    await focus('[name="password"]');
    browser.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    await until(() => popup()?.webContents.executeJavaScript("document.activeElement.tagName === 'BUTTON'"), "keyboard dismissal target");
    popup().webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await until(() => !popup() && browser.webContents.isFocused(), "Escape restores browser focus");
    await delay(100); assert.equal(popup(), undefined);
    console.log("PASS: clicking a filled field reopens choices; Escape restores focus without reopening");
    await browser.webContents.loadURL(website + "/signup");
    await browser.webContents.executeJavaScript("document.querySelector('[name=username]').focus()"); await delay(150);
    assert.equal(popup(), undefined);
    await browser.webContents.loadURL(website + "/login");
    await browser.webContents.executeJavaScript("document.querySelector('#otp').focus()"); await delay(150);
    assert.equal(popup(), undefined);
    await focus('[name="password"]');
    await browser.webContents.loadURL(website + "/moved"); await delay(150);
    assert.equal(popup(), undefined);
    assert.equal(await browser.webContents.executeJavaScript("document.querySelector('[name=password]').value"), "");
    console.log("PASS: password creation, OTP and navigation dismiss or suppress suggestions");
  } catch (error) { status = 1; console.error(error); }
  finally { releaseCredentialRead(); panel.destroy(); window.destroy(); site.close(); await once(site, "close"); app.exit(status); }
  }).catch(error => { console.error(error); app.exit(1); });
}
