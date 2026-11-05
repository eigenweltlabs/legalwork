import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserPasswordStore } from "../../server/dist/browser-passwords.js";
import { OAuthVault } from "../../server/dist/file-storage/oauth/vault.js";
import { createBrowserPage } from "../electron/browser-native/runtime/chromium.mjs";
import { createBrowserPasswordActions } from "../electron/browser-passwords.mjs";
import { createBrowserAutomationBroker } from "../electron/browser-automation-broker.mjs";

// Manual live-site smoke: synthetic credentials, isolated storage, no submission.
const website = new URL(process.argv[2]);
const expectedHost = process.argv[3];
assert.equal(website.protocol, "https:");
assert.ok(expectedHost, "Provide the final login hostname to wait for after redirects.");
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-password-website-")));
app.setPath("userData", path.join(root, "profile"));
const password = "synthetic-website-smoke-only-27";
const deadline = setTimeout(() => { console.error("Live website password smoke timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  let status = 0, window, page, broker;
  try {
    const store = new BrowserPasswordStore(new OAuthVault(path.join(root, "synthetic.vault")));
    const saved = await store.save({ label: "Synthetic live-site check", origin: website.origin, username: "", password });
    window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
    await window.loadURL("about:blank");
    let next = 0;
    page = createBrowserPage(window, { id: "website-smoke", partition: "website-smoke", network: null,
      publish: () => {}, fail: () => {}, popup: () => { throw new Error("Unexpected popup"); },
      localDownloadDirectory: root, shared: { ref: () => `e${++next}` },
      embeds: { create: () => ({ id: "hidden", show: () => {}, on: () => () => {}, dispose: () => {} }) },
    });
    await page.ready;
    await page.contents.loadURL(website.href);
    const signal = new AbortController().signal;
    let ref;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (new URL(page.contents.getURL()).hostname === expectedHost && !page.contents.isLoading()) {
        const snapshot = await page.execute({ action: { type: "snapshot", tabID: "website-smoke" }, files: [] }, signal);
        ref = snapshot.value.content.split("\n").find(line => /password/i.test(line) && line.includes("[textbox]"))?.match(/@(e\d+)/)?.[1];
        if (ref) break;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(ref, "The final login page must expose a native password-field ref.");
    const finalURL = page.contents.getURL();
    assert.notEqual(new URL(finalURL).hostname, website.hostname, "Use a login redirect to a different subdomain for this smoke.");
    broker = createBrowserAutomationBroker({ authorize: async context => assert.equal(context.sessionId, "synthetic-chat") });
    const connection = await broker.grant(page.contents, () => [], { sessionId: "synthetic-chat" }, undefined, undefined,
      createBrowserPasswordActions(page, async () => store));
    const headers = { "x-legalwork-browser-session": "synthetic-chat", "content-type": "application/json" };
    const listing = await (await fetch(`${connection.browser_url}/passwords`, { headers })).json();
    assert.equal(listing.website, new URL(finalURL).origin);
    assert.equal(listing.passwords[0]?.id, saved.id);
    let navigated = false;
    page.contents.on("will-navigate", () => { navigated = true; });
    const response = await fetch(`${connection.browser_url}/fill-password`, { method: "POST", headers,
      body: JSON.stringify({ password_id: saved.id, ref: `@${ref}` }) });
    const output = await response.text();
    assert.equal(response.status, 200, output);
    assert.equal(output.includes(password), false);
    assert.equal(await page.contents.executeJavaScript(`document.querySelector('input[type="password"]').value === ${JSON.stringify(password)}`), true);
    const after = await page.execute({ action: { type: "snapshot", tabID: "website-smoke" }, files: [] }, signal);
    assert.equal(JSON.stringify(after).includes(password), false);
    assert.equal(navigated, false);
    assert.equal(page.contents.getURL(), finalURL);
    assert.equal(BrowserWindow.getAllWindows().some(win => win.isVisible() || win.isFocused()), false);
    console.log(JSON.stringify({ passed: true, savedWebsite: website.origin, currentWebsite: listing.website,
      redirected: true, found: listing.passwords.length, filled: true, submitted: false,
      passwordInResultOrSnapshot: false, windowsHidden: true, realCredentials: false, modelCalls: 0 }, null, 2));
  } catch (error) { status = 1; console.error(error); }
  finally {
    clearTimeout(deadline); await broker?.close(); await page?.dispose(); window?.destroy();
    rmSync(root, { recursive: true, force: true }); app.exit(status);
  }
});
