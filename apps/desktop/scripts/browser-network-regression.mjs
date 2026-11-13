import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BaseWindow, BrowserWindow, WebContentsView, clipboard, session } from "electron";
import WebSocket from "ws";
import { createBrowserPanel } from "../electron/browser-panel.mjs";
import { requireBrowserNetwork } from "../electron/browser-network-policy.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "legalwork-browser-network-"));
app.setPath("userData", path.join(root, "profile"));
setTimeout(() => { console.error("Browser network regression timed out."); app.exit(1); }, 30000).unref();
const policies = new Map();
const hits = [];
const fixture = createServer((request, response) => {
  const match = /^\/workspace\/project\/sandbox\/session\/([^/]+)$/.exec(request.url);
  if (match) {
    assert.equal(request.headers.authorization, "Bearer fixture");
    const policy = policies.get(match[1]);
    response.writeHead(policy ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(policy ?? {}));
    return;
  }
  hits.push(request.url);
  response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Network policy fixture</title><h1>Allowed page</h1>");
});

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Policy revocation did not close the page");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const server = { running: true, baseUrl: origin, clientToken: "fixture" };
  const main = new BrowserWindow({ show: false });
  const panel = createBrowserPanel({
    app, BaseWindow, WebContentsView, clipboard, session,
    getWindow: () => main, getWindowForEvent: () => main,
    authorizeBrowserAutomation: context => requireBrowserNetwork(context, server),
    isAllowedAppNavigation: () => false,
    safeOpen: { openExternal: async () => false, openPath: async () => "", showItemInFolder: () => {} },
    resolveDownloadDirectory: async () => root,
  });
  const handlers = new Map();
  panel.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on: () => {} });
  const invoke = (method, ...args) => handlers.get(`legalwork:browser:${method}`)({ sender: main.webContents }, ...args);
  const context = sessionId => ({ workspaceId: "project", sessionId });
  const open = sessionId => invoke("openUrl", `${origin}/${sessionId}`, "builtin", context(sessionId));
  let client;
  let exitCode = 0;
  try {
    await main.loadURL("about:blank");
    for (const enabled of [true, false]) {
      for (const networkMode of ["allow", "approve", "block"]) {
        const id = `${enabled}-${networkMode}`;
        policies.set(id, { enabled, networkMode });
        if (enabled && networkMode !== "allow") {
          const count = hits.length;
          await assert.rejects(open(id), /disabled/);
          await assert.rejects(invoke("setProxy", "http://127.0.0.1:1", context(id)), /disabled/);
          assert.equal(hits.length, count, "A denied browser operation contacted a destination");
          assert.equal(invoke("listTabs").length, 0);
        } else {
          const tab = await open(id);
          assert.equal(tab.snapshot.error, undefined);
          assert.ok(hits.includes(`/${id}`));
          invoke("dismissTab", tab.tab_id);
          invoke("releaseSession", id);
        }
      }
    }
    console.log("PASS: actual Electron tabs obey all six sandbox/network combinations before navigation or proxy changes");

    policies.set("live", { enabled: true, networkMode: "allow" });
    const live = await open("live");
    const [target] = await (await fetch(`${live.browser_url}/json/list`)).json();
    client = new WebSocket(target.webSocketDebuggerUrl);
    await once(client, "open");
    policies.set("live", { enabled: true, networkMode: "approve" });
    const closed = once(client, "close");
    client.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `fetch('${origin}/forbidden')` } }));
    await closed;
    assert.equal(hits.includes("/forbidden"), false);
    assert.equal((await fetch(`${live.browser_url}/json/list`)).status, 403);
    assert.equal((await fetch(`${live.browser_url}/batch`, { method: "POST", body: JSON.stringify({ steps: [] }) })).status, 403);
    console.log("PASS: existing CDP connections and capability URLs cannot bypass a changed policy");

    policies.set("idle", { enabled: true, networkMode: "allow" });
    const idle = await open("idle");
    const manual = await invoke("createTab", `${origin}/manual`);
    policies.set("other-chat", { enabled: true, networkMode: "allow" });
    const other = await open("other-chat");
    policies.set("idle", { enabled: true, networkMode: "block" });
    await waitUntil(() => !invoke("listTabs").some(tab => tab.id === idle.tab_id));
    assert.ok(invoke("listTabs").some(tab => tab.id === manual.tabId));
    assert.ok(invoke("listTabs").some(tab => tab.id === other.tab_id));
    assert.equal((await fetch(`${other.browser_url}/json/list`)).status, 200);
    await assert.rejects(invoke("openUrl", origin, "builtin"), /calling project and chat/);
    await assert.rejects(open("unknown"), /cannot be verified/);
    console.log("PASS: policy polling closes agent pages without another call; manual tabs and other chats remain available");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    client?.terminate();
    panel.destroy();
    main.destroy();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(exitCode);
  }
}).catch(error => { console.error(error); app.exit(1); });
