import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserPasswordStore } from "../../server/dist/browser-passwords.js";
import { OAuthVault } from "../../server/dist/file-storage/oauth/vault.js";
import { createBrowserPage } from "../electron/browser-native/runtime/chromium.mjs";
import { createBrowserPasswordActions } from "../electron/browser-passwords.mjs";
import { createBrowserAutomationBroker } from "../electron/browser-automation-broker.mjs";

// This regression must leave the operator's desktop and browser profile alone.
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-password-fill-")));
app.setPath("userData", path.join(root, "profile"));
const password = "synthetic-login-password-27", checks = [];
const site = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html>
  <title>Password fill fixture</title><h1>Sign in</h1><form onsubmit="event.preventDefault();window.submitted=true">
  <label>Username<input name="username" autocomplete="username"></label>
  <label>Password<input name="password" type="password" autocomplete="current-password"></label>
  <button>Sign in</button></form>`));
const deadline = setTimeout(() => { console.error("Password fill regression timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  let status = 0, page, window, broker;
  try {
    site.listen(0, "127.0.0.1"); await once(site, "listening");
    const website = `http://127.0.0.1:${site.address().port}`;
    const vault = new OAuthVault(path.join(root, "existing.vault")), store = new BrowserPasswordStore(vault);
    const saved = await store.save({ label: "Portal fixture", origin: website, username: "lawyer", password });
    window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
    await window.loadURL("about:blank");
    let next = 0;
    page = createBrowserPage(window, { id: "password-tab", partition: "password-regression", network: null,
      publish: () => {}, fail: () => {}, popup: () => { throw new Error("Unexpected popup"); },
      localDownloadDirectory: root, shared: { ref: () => `e${++next}` },
      embeds: { create: () => ({ id: "hidden", show: () => {}, on: () => () => {}, dispose: () => {} }) },
    });
    await page.ready;
    await page.contents.loadURL(website);
    await page.contents.executeJavaScript("window.beforeFill=true;window.submitted=false");
    const observation = await page.execute({ action: { type: "snapshot", tabID: "password-tab" }, files: [] }, new AbortController().signal);
    const line = observation.value.content.split("\n").find(line => line.includes('"Password"') && line.includes("@"));
    const ref = line?.match(/@(e\d+)/)?.[1];
    assert.ok(ref, `No password ref in ${JSON.stringify(observation.value)}`);
    const initialContents = page.contents;
    broker = createBrowserAutomationBroker({ authorize: async context => assert.equal(context.sessionId, "chat-password") });
    const connection = await broker.grant(page.contents, () => [], { sessionId: "chat-password" }, undefined, undefined, createBrowserPasswordActions(page, async () => store));
    const headers = { "x-legalwork-browser-session": "chat-password", "content-type": "application/json" };
    const listing = await (await fetch(`${connection.browser_url}/passwords`, { headers })).text();
    assert.ok(listing.includes(saved.id)); assert.equal(listing.includes(password), false);
    checks.push("Only matching metadata reaches the agent-facing list");
    const response = await fetch(`${connection.browser_url}/fill-password`, { method: "POST", headers, body: JSON.stringify({ password_id: saved.id, ref }) });
    const output = await response.text();
    assert.equal(response.status, 200, output); assert.equal(output.includes(password), false);
    assert.equal(await page.contents.executeJavaScript("document.querySelector('[name=password]').value"), password);
    assert.equal(page.contents, initialContents);
    assert.equal(await page.contents.executeJavaScript("window.beforeFill && !window.submitted"), true);
    const afterFill = await page.execute({ action: { type: "snapshot", tabID: "password-tab" }, files: [] }, new AbortController().signal);
    assert.equal(JSON.stringify(afterFill).includes(password), false);
    assert.equal(JSON.stringify(await broker.snapshot(page.contents)).includes(password), false);
    checks.push("The encrypted vault password fills the existing native page without submitting or echoing it");
    // Confirm the accepted v1 limit: ordinary browser readback remains available.
    assert.equal((await page.execute({ action: { type: "evaluate", tabID: "password-tab", script: "document.querySelector('[name=password]').value" }, files: [] }, new AbortController().signal)).value.value, password);
    checks.push("Unrestricted native browser readback is unchanged");
    await page.contents.loadURL(website + "/after-navigation");
    const stale = await fetch(`${connection.browser_url}/fill-password`, { method: "POST", headers, body: JSON.stringify({ password_id: saved.id, ref }) });
    assert.equal(stale.status, 400);
    assert.equal((await stale.text()).includes(password), false);
    assert.equal(await page.contents.executeJavaScript("document.querySelector('[name=password]').value"), "");
    checks.push("A stale ref after navigation fails without inserting a password");
    assert.equal(BrowserWindow.getAllWindows().some(win => win.isVisible() || win.isFocused()), false);
    checks.push("All windows remained hidden and unfocused");
    console.log(JSON.stringify({ passed: checks, modelCalls: 0, realCredentials: false }, null, 2));
  } catch (error) { status = 1; console.error(error); }
  finally {
    clearTimeout(deadline); await broker?.close(); await page?.dispose();
    window?.destroy(); site.close(); await once(site, "close");
    rmSync(root, { recursive: true, force: true }); app.exit(status);
  }
});
