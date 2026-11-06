import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

// Real Chromium, isolated profile, hidden windows, no model or personal account.
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-observation-")));
app.setPath("userData", path.join(root, "profile"));
const controller = process.env.LEGALWORK_TEST_BROWSER_CONTROLLER ?? path.resolve(import.meta.dirname, "../electron/browser-native/runtime");
const { createBrowserPage } = await import(pathToFileURL(path.join(controller, "chromium.mjs")).href);
const checks = [];
const site = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  if (request.url === "/long") return response.end(`<!doctype html><title>Long results</title>${Array.from({ length: 600 }, (_, i) => `<button>Record ${i}</button>`).join("")}<input aria-label="Final record">`);
  if (request.url === "/frame") return response.end('<!doctype html><title>Frame</title><input aria-label="Frame field">');
  if (request.url === "/frames") return response.end(`<!doctype html><title>Frames</title><iframe src="/frame"></iframe><iframe src="http://localhost:${site.address().port}/frame"></iframe>`);
  if (request.url === "/deep") return response.end(`<!doctype html><title>Deep form</title><h1>Deep form</h1>${"<div>".repeat(40)}<main><label>Case number <input aria-label="Case number"></label><button>Search records</button><button style="display:none">Hidden action</button></main>${"</div>".repeat(40)}`);
  response.end(`<!doctype html><title>Nested editor</title>
  <h1>Editor fixture</h1>${'<div role="group">'.repeat(25)}
  <nested-editor></nested-editor>${"</div>".repeat(25)}
  <label>Password<input type="password" value="synthetic-protected-value"></label>
  ${Array.from({ length: 550 }, (_, i) => `<p>Background paragraph ${i}</p>`).join("")}
  <button>Last action beyond the snapshot budget</button>
  <script>customElements.define('nested-editor',class extends HTMLElement {connectedCallback(){
    this.attachShadow({mode:'open'}).innerHTML='<div role="textbox" aria-label="Source text" contenteditable="true"></div><div role="textbox" aria-label="Translated text" aria-readonly="true"></div>';
    this.shadowRoot.querySelector('[contenteditable]').addEventListener('input',()=>this.shadowRoot.querySelector('[aria-readonly]').textContent='Hello from the nested editor');
  }});</script>`);
});
const deadline = setTimeout(() => { console.error("Browser observation regression timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  let status = 0, page, window;
  try {
    site.listen(0, "127.0.0.1"); await once(site, "listening");
    const origin = `http://127.0.0.1:${site.address().port}`;
    window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
    await window.loadURL("about:blank");
    let next = 0;
    page = createBrowserPage(window, { id: "nested-tab", partition: "observation-regression", network: null,
      publish: () => {}, fail: () => {}, popup: () => { throw new Error("Unexpected popup"); },
      localDownloadDirectory: root, shared: { ref: () => `e${++next}` },
      embeds: { create: () => ({ id: "hidden", show: () => {}, on: () => () => {}, dispose: () => {} }) },
    });
    await page.ready; await page.contents.loadURL(origin);
    const run = async (action, generation) => (await page.execute({ action: { tabID: "nested-tab", ...action }, files: [], ...(generation === undefined ? {} : { generation }) }, new AbortController().signal)).value;
    const ref = (snapshot, label, role) => {
      const line = snapshot.content.split("\n").find(line => line.includes(`[${role}]`) && line.includes(JSON.stringify(label)));
      const value = line?.match(/@e\d+/)?.[0];
      assert.ok(value, `Missing ${role} ${label}`);
      return value;
    };
    const initial = await run({ type: "snapshot" });
    const sourceRef = initial.content.split("\n").find(line => line.includes('"Source text"'))?.match(/@e\d+/)?.[0];
    assert.ok(sourceRef, "The default snapshot must include a deeply nested shadow-DOM editor");
    assert.equal(initial.content.includes("synthetic-protected-value"), false);
    assert.equal(initial.truncated, true, "The rendered observation remains bounded on a long page");
    await run({ type: "fill", ref: sourceRef, text: "Nested text" });
    const scoped = await run({ type: "snapshot", ref: sourceRef, depth: 2 });
    assert.match(scoped.content, /Source text.*Nested text/);
    assert.equal(scoped.content.includes("Background paragraph"), false);
    const after = await run({ type: "snapshot" });
    assert.match(after.content, /Nested text/);
    assert.match(after.content, /Hello from the nested editor/);
    assert.equal(after.content.includes("synthetic-protected-value"), false);
    checks.push("Default observations expose usable nested/shadow editor refs and edited/read-only text, without password values");
    const shallow = await run({ type: "snapshot", depth: 0 });
    assert.equal(shallow.content.includes("Source text"), false);
    assert.equal(shallow.truncated, true);
    checks.push("Explicit depth and ref-scoped observations retain their bounds");
    const found = await run({ type: "find", text: "Last action beyond" });
    assert.match(found.content, /@e\d+ \[button\] "Last action beyond the snapshot budget"/);
    checks.push("Focused find searches beyond the default snapshot's output budget");
    await page.contents.loadURL(origin + "/next");
    await run({ type: "wait", condition: "load", timeoutMs: 1000 }, initial.tab.generation);
    await run({ type: "wait", condition: "text", text: "Editor fixture", timeoutMs: 1000 }, initial.tab.generation);
    await assert.rejects(run({ type: "fill", ref: sourceRef, text: "must not insert" }, initial.tab.generation), /document changed/i);
    checks.push("Condition waits follow navigation while stale document mutations still fail");
    await run({ type: "navigate", url: origin + "/deep" });
    const deep = await run({ type: "snapshot" });
    const field = ref(deep, "Case number", "textbox");
    assert.equal(deep.truncated, false);
    ref(deep, "Search records", "button");
    assert.doesNotMatch(deep.content, /Hidden action|\[InlineTextBox\]|\[generic\] ""/);
    await run({ type: "fill", ref: field, text: "Observed through forty wrappers" });
    assert.equal((await run({ type: "evaluate", script: "document.querySelector('input').value" })).value, "Observed through forty wrappers");
    const semantic = await run({ type: "snapshot", depth: 1 });
    assert.equal(semantic.truncated, true);
    assert.doesNotMatch(semantic.content, /\[textbox\]/);
    ref(await run({ type: "snapshot", depth: 2 }), "Search records", "button");
    ref(await run({ type: "snapshot", depth: 3 }), "Case number", "textbox");
    const caseMatch = await run({ type: "find", text: "CASE NUMBER" });
    assert.equal(caseMatch.truncated, false);
    await run({ type: "fill", ref: ref(caseMatch, "Case number", "textbox"), text: "Fresh find ref" });
    await assert.rejects(run({ type: "fill", ref: field, text: "Stale ref" }), /stale|another tab/i);
    checks.push("Forty layout wrappers, hidden/duplicate content, semantic depth and case-insensitive fresh/stale refs retain #342 coverage");
    await run({ type: "navigate", url: origin + "/long" });
    const bounded = await run({ type: "snapshot" });
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.content.split("\n").length <= 500);
    assert.doesNotMatch(bounded.content, /Final record/);
    const late = await run({ type: "find", text: "final RECORD" });
    assert.equal(late.truncated, false);
    await run({ type: "fill", ref: ref(late, "Final record", "textbox"), text: "Found after 600 records" });
    assert.equal((await run({ type: "evaluate", script: "document.querySelector('input').value" })).value, "Found after 600 records");
    const many = await run({ type: "find", text: "Record " });
    assert.equal(many.truncated, true);
    assert.equal(many.content.split("\n").length, 500);
    assert.ok(many.content.length <= 100000);
    const absent = await run({ type: "find", text: "No matching record exists" });
    assert.equal(absent.content, "");
    assert.equal(absent.truncated, false);
    checks.push("Full-tree find reaches controls after 600 records and bounds matching results without truncating absent matches");
    await run({ type: "navigate", url: origin + "/frames" });
    const frames = (await run({ type: "frames" })).frames.filter(frame => frame.parentID);
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      const snapshot = await run({ type: "find", frameID: frame.id, text: "Frame field" });
      await run({ type: "fill", ref: ref(snapshot, "Frame field", "textbox"), text: "Frame preserved" });
      assert.equal((await run({ type: "evaluate", frameID: frame.id, script: "document.querySelector('input').value" })).value, "Frame preserved");
    }
    checks.push("Same-origin and cross-origin frame searches retain the correct action target");
    assert.equal(BrowserWindow.getAllWindows().some(win => win.isVisible() || win.isFocused()), false);
    checks.push("All windows remained hidden and unfocused");
    console.log(JSON.stringify({ passed: true, checks, snapshotChars: initial.content.length, modelCalls: 0 }, null, 2));
  } catch (error) { status = 1; console.error(error); }
  finally {
    clearTimeout(deadline); await page?.dispose(); window?.destroy();
    site.close(); site.closeAllConnections(); rmSync(root, { recursive: true, force: true }); app.exit(status);
  }
});
