import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createBrowserPage } from "../electron/browser-native/runtime/chromium.mjs";

// Manual public-site smoke; no sign-in, personal profile or model inference.
// Arguments: URL, accessible source-field name pattern, input, expected output pattern.
const [website, sourcePattern, text, expectedPattern] = process.argv.slice(2);
assert.equal(new URL(website).protocol, "https:");
assert.ok(sourcePattern && text && expectedPattern, "Supply URL, source label, input and expected output");
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-editor-website-")));
app.setPath("userData", path.join(root, "profile"));
const deadline = setTimeout(() => { console.error("Live editor smoke timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  let status = 0, window, page;
  try {
    window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
    await window.loadURL("about:blank");
    let next = 0;
    page = createBrowserPage(window, { id: "website-editor", partition: "editor-website-smoke", network: null,
      publish: () => {}, fail: () => {}, popup: () => { throw new Error("Unexpected popup"); }, localDownloadDirectory: root,
      shared: { ref: () => `e${++next}` }, embeds: { create: () => ({ id: "hidden", show: () => {}, on: () => () => {}, dispose: () => {} }) },
    });
    await page.ready; await page.contents.loadURL(website);
    const run = async action => (await page.execute({ action: { tabID: "website-editor", ...action }, files: [] }, new AbortController().signal)).value;
    let initial, ref, observations = 0;
    const started = Date.now();
    while (Date.now() - started < 15000) {
      initial = await run({ type: "snapshot" }); observations++;
      const line = initial.content.split("\n").find(line => /\[textbox\]|\[searchbox\]/.test(line) && new RegExp(sourcePattern, "i").test(line) && !line.includes("readonly=true"));
      ref = line?.match(/@e\d+/)?.[0];
      if (ref) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(ref, `No observed editor matching ${sourcePattern}. Textbox observations: ${initial?.content.split("\n").filter(line => /textbox|searchbox/.test(line)).join("\n")}`);
    const initialObservations = observations;
    await run({ type: "fill", ref, text });
    let after;
    while (Date.now() - started < 25000) {
      after = await run({ type: "snapshot" }); observations++;
      if (new RegExp(expectedPattern, "i").test(after.content)) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.match(after.content, new RegExp(expectedPattern, "i"));
    assert.equal(BrowserWindow.getAllWindows().some(win => win.isVisible() || win.isFocused()), false);
    console.log(JSON.stringify({ passed: true, website: new URL(website).origin, editorObservedInNativeSnapshot: true,
      usedNativeFill: true, resultInNativeSnapshot: true, initialObservations, observations, elapsedMs: Date.now() - started,
      windowsHidden: true, modelCalls: 0, realCredentials: false }, null, 2));
  } catch (error) { status = 1; console.error(error); }
  finally { clearTimeout(deadline); await page?.dispose(); window?.destroy(); rmSync(root, { recursive: true, force: true }); app.exit(status); }
});
