import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BaseWindow, BrowserWindow, WebContentsView, clipboard, session } from "electron";
import WebSocket from "ws";
import { createBrowserPanel } from "../electron/browser-panel.mjs";
import { resolveBrowserProject } from "../electron/browser-project.mjs";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-browser-workflow-")));
app.setPath("userData", path.join(root, "profile"));
setTimeout(() => { console.error("Browser workflow regression timed out."); app.exit(1); }, 30000).unref();
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
mkdirSync(projectA);
mkdirSync(projectB);
const state = {
  selectedId: "a",
  workspaces: [
    { id: "a", path: projectA, workspaceType: "local" },
    { id: "b", path: projectB, workspaceType: "local" },
    { id: "remote", workspaceType: "remote" },
  ],
};
const file = Buffer.from("LegalWork browser download fixture\n");
const fixture = createServer((request, response) => {
  if (request.url === "/unavailable") {
    request.socket.destroy();
    return;
  }
  if (request.url === "/download") {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="record.txt"',
      "Content-Length": file.length,
    });
    response.end(file);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  // A slow destination must not return the tab's initial about:blank snapshot.
  setTimeout(() => response.end(`<!doctype html><title>Browser workflow fixture</title>
    <style>body{font:18px sans-serif;padding:32px}label{display:block;margin:16px 0}input,textarea,select,button{font:inherit}</style>
    <h1>Browser workflow fixture</h1><div><div>
    <label for="applicant">Applicant</label><input id="applicant">
    <label for="notes">Notes</label><textarea id="notes"></textarea>
    <label for="region">Region</label><select id="region"><option>West</option><option>East</option></select>
    <label for="locked">Locked field</label><input id="locked" readonly value="unchanged">
    <button id="save" onclick="setTimeout(() => document.querySelector('#result').textContent = 'Saved ' + document.querySelector('#applicant').value + ' in ' + document.querySelector('#region').value, 50)">Save</button>
    <p id="result">Not saved</p><a id="download" href="/download">Download record</a>
    </div></div>`), 100);
});

async function batch(tab, steps, timeout_ms = 5000) {
  const response = await fetch(`${tab.browser_url}/batch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps, timeout_ms }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function download(tab, count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${tab.browser_url}/downloads`);
    assert.equal(response.status, 200);
    const { downloads } = await response.json();
    if (downloads.length >= count && downloads[count - 1].state !== "progressing") return downloads[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Download did not reach a terminal state.");
}

let commandId = 0;
function command(client, method, params = {}) {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off("message", receive); reject(new Error("CDP response timed out")); }, 5000);
    function receive(data) {
      const message = JSON.parse(data.toString());
      if (message.id !== id) return;
      clearTimeout(timer);
      client.off("message", receive);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
    client.on("message", receive);
    client.send(JSON.stringify({ id, method, params }));
  });
}

app.whenReady().then(async () => {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const main = new BrowserWindow({ show: false });
  const panel = createBrowserPanel({
    authorizeBrowserAutomation: async () => {},
    app, BaseWindow, WebContentsView, clipboard, session,
    getWindow: () => main, getWindowForEvent: () => main,
    isAllowedAppNavigation: () => false,
    safeOpen: { openExternal: async () => false, openPath: async () => "", showItemInFolder: () => {} },
    resolveDownloadDirectory: (context) => resolveBrowserProject(context, state, { running: false }),
  });
  const handlers = new Map();
  panel.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on: () => {} });
  const invoke = (method, ...args) => handlers.get(`legalwork:browser:${method}`)({ sender: main.webContents }, ...args);
  let client;
  let exitCode = 0;
  try {
    // A real renderer shows and sizes the panel before reading visible controls.
    // Initialize the host too, so Chromium can paint the screenshot on CI.
    await main.loadURL("about:blank");
    main.setContentSize(900, 700);
    invoke("show", { x: 0, y: 0, width: 900, height: 700 });
    main.show();
    const first = await invoke("openUrl", origin, "builtin", { directory: projectA, workspaceId: "a", sessionId: "task-a" });
    assert.equal(main.contentView.children.length, 0);
    assert.equal(invoke("state").activeTabId, null);
    assert.equal(first.download_directory, path.join(projectA, "Downloads"));
    assert.equal(first.snapshot.error, undefined);
    for (const name of ["Applicant", "Notes", "Region", "Save", "Download record"]) {
      assert.ok(first.snapshot.controls.some((control) => control.name === name), `Missing control: ${name}; snapshot: ${JSON.stringify(first.snapshot)}`);
    }
    const selector = (name) => first.snapshot.controls.find((control) => control.name === name).selector;
    console.log("PASS: opening a project tab returns labeled controls and observed selectors");

    const foreground = await invoke("createTab", `${origin}/foreground`);
    const foregroundView = main.contentView.children[0];
    const second = await invoke("openUrl", origin, "builtin", { directory: projectA });
    assert.deepEqual(invoke("state").tabs.map(tab => tab.id), [first.tab_id, foreground.tabId, second.tab_id]);
    assert.equal(invoke("state").activeTabId, foreground.tabId);
    assert.deepEqual(main.contentView.children, [foregroundView]);
    invoke("closeTab", second.tab_id);
    assert.match(await invoke("previewTab", first.tab_id), /^data:image\/png;base64,/);
    assert.deepEqual(main.contentView.children, [foregroundView]);
    assert.equal(invoke("state").activeTabId, foreground.tabId);
    console.log("PASS: hidden task previews render without showing or selecting their native view");

    const [target] = await (await fetch(`${first.browser_url}/json/list`)).json();
    client = new WebSocket(target.webSocketDebuggerUrl);
    await once(client, "open");
    assert.match(await invoke("previewTab", first.tab_id), /^data:image\/png;base64,/);
    assert.equal(client.readyState, WebSocket.OPEN, "A preview must share the agent's debugger connection");
    const previewOnly = await invoke("openUrl", origin, "builtin", { directory: projectA, sessionId: "task-b" });
    for (const preview of await Promise.all([invoke("previewTab", first.tab_id), invoke("previewTab", previewOnly.tab_id)])) assert.match(preview, /^data:image\/png;base64,/);
    assert.equal(BaseWindow.getAllWindows().filter(win => win.isVisible()).length, 1, "Preview hosts must never become visible");
    invoke("releaseSession", "task-b");
    assert.deepEqual(main.contentView.children, [foregroundView]);
    const tree = await command(client, "Accessibility.getFullAXTree");
    const reachable = new Set();
    const visit = (id) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const child of tree.nodes.find((node) => node.nodeId === id)?.childIds ?? []) visit(child);
    };
    visit(tree.nodes.find((node) => node.role?.value === "RootWebArea").nodeId);
    assert.ok(tree.nodes.some((node) => reachable.has(node.nodeId) && node.role?.value === "textbox" && node.name?.value === "Applicant"));
    assert.ok(tree.nodes.every((node) => !node.ignored || node.name?.value));
    console.log("PASS: CDP accessibility traversal retains controls beneath ignored containers");

    const result = await batch(first, [
      { action: "fill", selector: selector("Applicant"), value: "Alice" },
      { action: "fill", selector: selector("Notes"), value: "Review complete" },
      { action: "fill", selector: selector("Region"), value: "East" },
      { action: "click", selector: selector("Save") },
      { action: "wait_for", text: "Saved Alice in East" },
    ]);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.completed.length, 5);
    assert.ok(result.snapshot.elements.some((node) => node.name === "Saved Alice in East"));
    const fields = await command(client, "Runtime.evaluate", { expression: "[document.querySelector('#applicant').value, document.querySelector('#notes').value, document.querySelector('#region').value]", returnByValue: true });
    assert.deepEqual(fields.result.value, ["Alice", "Review complete", "East"]);
    console.log("PASS: one batch fills input, textarea and select, clicks, waits and shares the CDP attachment");
    assert.deepEqual(main.contentView.children, [foregroundView]);
    assert.equal(invoke("state").activeTabId, foreground.tabId);
    console.log("PASS: agent tabs are listed and complete work without replacing the selected browser");

    // Revealing a working tab is an explicit user action, independent of the
    // agent's ability to inspect, fill, click, and download in the background.
    invoke("selectTab", first.tab_id);
    assert.deepEqual(main.contentView.children[0].getBounds(), { x: 0, y: 0, width: 900, height: 700 });
    invoke("selectTab", foreground.tabId);
    await command(client, "Page.navigate", { url: `${origin}/next` });
    await batch(first, [{ action: "wait_for", text: "Browser workflow fixture" }]);
    await command(client, "Runtime.evaluate", { expression: "document.querySelector('#applicant').focus()" });
    assert.equal(invoke("state").activeTabId, foreground.tabId);
    assert.deepEqual(main.contentView.children, [foregroundView]);
    // Restore the fixture form for the remaining workflow assertions.
    await batch(first, [
      { action: "fill", selector: "#applicant", value: "Alice" },
      { action: "fill", selector: "#region", value: "East" },
      { action: "click", selector: "#save" },
      { action: "wait_for", text: "Saved Alice in East" },
    ]);
    invoke("selectTab", first.tab_id);
    console.log("PASS: selecting an agent tab works, and later navigation or field focus cannot reselect it");
    invoke("closeTab", first.tab_id);
    assert.equal(invoke("state").tabs.find(tab => tab.id === first.tab_id).background, true);
    assert.equal((await batch(first, [{ action: "fill", selector: "#notes", value: "Still working after close" }])).ok, true);
    invoke("dismissTab", first.tab_id);
    assert.equal(invoke("state").tabs.find(tab => tab.id === first.tab_id).dismissed, true);
    assert.equal((await batch(first, [])).ok, true);
    assert.equal(invoke("state").tabs.find(tab => tab.id === first.tab_id).dismissed, false);
    invoke("selectTab", first.tab_id);
    console.log("PASS: closing and dismissing a task tab preserves its live automation connection");

    if (process.env.LEGALWORK_BROWSER_TEST_SCREENSHOT) {
      const contents = main.contentView.children[0].webContents;
      await contents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const screenshot = await contents.capturePage({ x: 0, y: 0, width: 900, height: 700 }, { stayAwake: true });
      assert.equal(screenshot.isEmpty(), false);
      writeFileSync(process.env.LEGALWORK_BROWSER_TEST_SCREENSHOT, screenshot.toPNG());
      console.log(`Screenshot: ${process.env.LEGALWORK_BROWSER_TEST_SCREENSHOT}`);
    }

    const failed = await batch(first, [
      { action: "fill", selector: selector("Applicant"), value: "Bob" },
      { action: "fill", selector: selector("Locked field"), value: "changed" },
      { action: "click", selector: selector("Save") },
    ]);
    assert.equal(failed.ok, false);
    assert.equal(failed.failedStep, 1);
    assert.deepEqual(failed.completed, [{ index: 0, action: "fill" }]);
    assert.match(failed.error, /read-only/);
    const unchanged = await command(client, "Runtime.evaluate", { expression: "document.querySelector('#result').textContent", returnByValue: true });
    assert.equal(unchanged.result.value, "Saved Alice in East");
    console.log("PASS: a failed step stops subsequent actions and reports the completed prefix");

    state.selectedId = "b";
    for (const count of [1, 2]) {
      assert.equal((await batch(first, [{ action: "click", selector: selector("Download record") }])).ok, true);
      const saved = await download(first, count);
      const name = count === 1 ? "record.txt" : "record (2).txt";
      assert.equal(saved.state, "completed", saved.error);
      assert.equal(saved.path, path.join(projectA, "Downloads", name));
      assert.equal(saved.relativePath, `Downloads/${name}`);
      assert.deepEqual(readFileSync(saved.path), file);
    }
    assert.deepEqual(readFileSync(path.join(projectA, "Downloads", "record.txt")), file);
    console.log("PASS: project switching preserves the original destination and repeated filenames never overwrite");

    const direct = await invoke("openUrl", `${origin}/download`, "builtin", { workspaceId: "b" });
    const saved = await download(direct, 1);
    assert.equal(saved.state, "completed", saved.error);
    assert.equal(saved.path, path.join(projectB, "Downloads", "record.txt"));
    assert.deepEqual(readFileSync(saved.path), file);
    console.log("PASS: a direct file URL downloads into its own project despite aborted page navigation");

    await assert.rejects(invoke("openUrl", `${origin}/unavailable`, "builtin", { directory: projectA }), /ERR_/);
    console.log("PASS: navigation failures without a download are still rejected");

    state.selectedId = "remote";
    const unbound = await invoke("openUrl", origin, "builtin");
    assert.equal(unbound.download_directory, null);
    assert.equal((await batch(unbound, [{ action: "click", selector: "#download" }])).ok, true);
    const cancelled = await download(unbound, 1);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.path, null);
    assert.match(cancelled.error, /not attached to a local project/);
    await assert.rejects(invoke("openUrl", origin, "builtin", { directory: root }), /not registered locally/);
    assert.equal((await fetch(`${first.browser_url}/downloads`, { headers: { Origin: origin } })).status, 403);
    console.log("PASS: remote and unknown projects cannot redirect local downloads; web origins are rejected");
    invoke("closeTab", first.tab_id);
    invoke("releaseSession", "task-a");
    assert.equal(invoke("state").tabs.some(tab => tab.id === first.tab_id), true);
    const continued = await invoke("connection", first.tab_id, { workspaceId: "a", sessionId: "task-a" });
    assert.equal(continued.browser_url, first.browser_url);
    invoke("dismissTab", first.tab_id);
    invoke("releaseSession", "task-a");
    assert.equal(invoke("state").tabs.some(tab => tab.id === first.tab_id), false);
    console.log("PASS: task tabs survive follow-up turns and explicit dismissal closes them at turn end");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    client?.terminate();
    panel.destroy();
    main.destroy();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    // Chromium may still be flushing the isolated profile after view teardown.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(exitCode);
  }
}).catch((error) => { console.error(error); app.exit(1); });
