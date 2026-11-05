import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { createBrowserAutomationBroker } from "./browser-automation-broker.mjs";

function deferred() {
  /** @type {() => void} */
  let release = () => { throw new Error("Deferred promise is not initialized"); };
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, resolve: release };
}

function browserTab(id) {
  const tab = Object.assign(new EventEmitter(), {
    id,
    destroyed: false,
    attached: false,
    commands: [],
    isDestroyed: () => tab.destroyed,
    getTitle: () => "Example page",
    getURL: () => "https://example.org/",
    destroy: () => { tab.destroyed = true; tab.emit("destroyed"); },
    close: () => tab.destroy(),
    debugger: Object.assign(new EventEmitter(), {
      attach: () => { assert.equal(tab.attached, false); tab.attached = true; },
      detach: () => { tab.attached = false; tab.emit("debugger-detached"); },
      /** @returns {Promise<Record<string, unknown>>} */
      sendCommand: async (method, params) => {
        tab.commands.push({ method, params });
        return { result: { value: "Example page" } };
      },
    }),
  });
  return tab;
}

async function connect(endpoint) {
  const client = new WebSocket(endpoint);
  await once(client, "open");
  return client;
}

async function command(client, message) {
  const result = once(client, "message");
  client.send(JSON.stringify(message));
  return JSON.parse((await result)[0].toString());
}

async function rejectedUpgrade(endpoint, options) {
  const client = new WebSocket(endpoint, options);
  client.on("error", () => {});
  const [_, response] = await once(client, "unexpected-response");
  response.resume();
  client.terminate();
  return response.statusCode;
}

function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: host } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("password operations require the exact chat capability and session, and reject legacy/remote tabs", async t => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  let fills = 0;
  const actions = { list: async () => ({ passwords: [{ id: "saved" }] }), fill: async body => { assert.deepEqual(body, { password_id: "saved", ref: "@e2" }); fills++; return { filled: true }; } };
  const local = await broker.grant(browserTab(201), () => [], { sessionId: "owner" }, undefined, undefined, actions);
  const other = await broker.grant(browserTab(202), () => [], { sessionId: "other" });
  for (const session of [undefined, "other"]) {
    const headers = session ? { "x-legalwork-browser-session": session } : {};
    assert.equal((await fetch(`${local.browser_url}/passwords`, { headers })).status, 403);
    assert.equal((await fetch(`${local.browser_url}/fill-password`, { method: "POST", headers, body: "{}" })).status, 403);
  }
  assert.equal(fills, 0);
  const headers = { "x-legalwork-browser-session": "owner", "content-type": "application/json" };
  assert.deepEqual(await (await fetch(`${local.browser_url}/passwords`, { headers })).json(), { passwords: [{ id: "saved" }] });
  assert.deepEqual(await (await fetch(`${local.browser_url}/fill-password`, { method: "POST", headers, body: JSON.stringify({ password_id: "saved", ref: "@e2" }) })).json(), { filled: true });
  assert.equal(fills, 1);
  assert.equal((await fetch(`${other.browser_url}/passwords`, { headers: { "x-legalwork-browser-session": "other" } })).status, 400);
});

test("discovery and WebSocket upgrades require a tab capability and reject web origins", async (t) => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  const first = await broker.grant(browserTab(10));
  const second = await broker.grant(browserTab(11));
  const base = new URL(first.browser_url).origin;
  for (const route of ["/json/list", "/json/version", "/wrong/json/list"]) {
    assert.equal((await fetch(`${base}${route}`)).status, 403);
  }
  assert.equal((await fetch(`${first.browser_url}/json/list`, { headers: { Origin: "https://example.org" } })).status, 403);
  assert.equal(await statusWithHost(`${first.browser_url}/json/list`, "rebound.example"), 403);
  assert.equal((await fetch(`${first.browser_url}/json/list`, { method: "POST" })).status, 403);
  const response = await fetch(`${first.browser_url}/json/list`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const targets = await response.json();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, first.target_id);
  assert.equal(await rejectedUpgrade(`${base.replace("http:", "ws:")}/devtools/page/${first.target_id}`), 403);
  assert.equal(await rejectedUpgrade(targets[0].webSocketDebuggerUrl, { origin: "https://example.org" }), 403);
  assert.equal(await rejectedUpgrade(targets[0].webSocketDebuggerUrl.replace(`/page/${first.target_id}`, `/page/${second.target_id}`)), 403);
});

test("page commands and events work while cross-target and browser commands are denied", async (t) => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  const tab = browserTab(20);
  const grant = await broker.grant(tab);
  const [target] = await (await fetch(`${grant.browser_url}/json/list`)).json();
  const client = await connect(target.webSocketDebuggerUrl);
  t.after(() => client.terminate());
  const response = await command(client, { id: 1, method: "Runtime.evaluate", params: { expression: "document.title" } });
  assert.equal(response.result.result.value, "Example page");
  for (const message of [
    { id: 2, method: "Target.attachToTarget", params: { targetId: "app-window" } },
    { id: 3, method: "Target.sendMessageToTarget" },
    { id: 4, method: "Browser.close" },
    { id: 5, method: "Runtime.evaluate", sessionId: "another-target" },
  ]) {
    const denied = await command(client, message);
    assert.equal(denied.error.code, -32601);
  }
  assert.equal(tab.commands.length, 1);
  const event = once(client, "message");
  tab.debugger.emit("message", {}, "Page.loadEventFired", { timestamp: 1 });
  assert.deepEqual(JSON.parse((await event)[0]), { method: "Page.loadEventFired", params: { timestamp: 1 } });
  const closed = once(client, "close");
  tab.destroy();
  await closed;
  assert.equal((await fetch(`${grant.browser_url}/json/list`)).status, 403);
  assert.equal(tab.attached, false);
});

test("concurrent clients share the attachment until the last disconnect", async (t) => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  const tab = browserTab(30);
  const grant = await broker.grant(tab);
  const [target] = await (await fetch(`${grant.browser_url}/json/list`)).json();
  const first = await connect(target.webSocketDebuggerUrl);
  const second = await connect(target.webSocketDebuggerUrl);
  const closed = once(first, "close");
  first.close();
  await closed;
  assert.equal(tab.attached, true);
  assert.equal((await command(second, { id: 1, method: "Page.captureScreenshot" })).error, undefined);
  const lastClosed = once(second, "close");
  const detached = once(tab, "debugger-detached");
  second.close();
  await Promise.all([lastClosed, detached]);
  assert.equal(tab.attached, false);
});

test("disconnecting during a pending command releases the debugger safely", async (t) => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  const tab = browserTab(40);
  tab.debugger.sendCommand = async () => {
    const finished = once(tab, "finish-command");
    tab.emit("command-started");
    await finished;
    throw new Error("Tab closed while the command was running");
  };
  const grant = await broker.grant(tab);
  const [target] = await (await fetch(`${grant.browser_url}/json/list`)).json();
  const client = await connect(target.webSocketDebuggerUrl);
  const started = once(tab, "command-started");
  client.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "pending()" } }));
  await started;
  const detached = once(tab, "debugger-detached");
  client.terminate();
  await detached;
  tab.emit("finish-command");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.attached, false);
});

test("policy changes deny existing HTTP capabilities and new WebSocket connections", async t => {
  for (const route of ["json/list", "downloads", "batch", "websocket"]) {
    let allowed = true;
    const context = { workspaceId: "project", sessionId: "chat" };
    const broker = createBrowserAutomationBroker({ authorize: async caller => {
      assert.deepEqual(caller, context);
      if (!allowed) throw new Error("Browser tools are disabled by network policy.");
    } });
    t.after(() => broker.close());
    const tab = browserTab(50);
    const grant = await broker.grant(tab, () => [], context);
    const [target] = await (await fetch(`${grant.browser_url}/json/list`)).json();
    allowed = false;
    if (route === "websocket") assert.equal(await rejectedUpgrade(target.webSocketDebuggerUrl), 403);
    else assert.equal((await fetch(`${grant.browser_url}/${route}`, route === "batch" ? { method: "POST", body: JSON.stringify({ steps: [] }) } : {})).status, 403);
    assert.equal(tab.commands.length, 0);
    assert.equal(tab.destroyed, true);
    await assert.rejects(broker.grant(browserTab(51), () => [], context), /disabled/);
  }
});

test("an already connected browser cannot execute commands after network access is revoked", async t => {
  let allowed = true;
  const broker = createBrowserAutomationBroker({ authorize: async () => {
    if (!allowed) throw new Error("Browser tools are disabled.");
  } });
  t.after(() => broker.close());
  const tab = browserTab(60);
  const grant = await broker.grant(tab);
  const [target] = await (await fetch(`${grant.browser_url}/json/list`)).json();
  const client = await connect(target.webSocketDebuggerUrl);
  const closed = once(client, "close");
  allowed = false;
  client.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "fetch('https://example.org')" } }));
  await closed;
  assert.equal(tab.commands.length, 0);
  assert.equal(tab.destroyed, true);
});

test("policy revocation closes a running page without waiting for another tool call", async t => {
  let allowed = true;
  const broker = createBrowserAutomationBroker({ authorize: async () => {
    if (!allowed) throw new Error("Network policy cannot be verified.");
  } });
  t.after(() => broker.close());
  const tab = browserTab(70);
  await broker.grant(tab);
  const closed = once(tab, "destroyed");
  allowed = false;
  // Keep the fixture alive while the broker's unreferenced policy timer fires.
  const deadline = setTimeout(() => tab.emit("policy-timeout"), 3000);
  t.after(() => clearTimeout(deadline));
  await Promise.race([closed, once(tab, "policy-timeout").then(() => { throw new Error("Page was not revoked"); })]);
  assert.equal(tab.destroyed, true);
});

test("capture, thumbnail and raw CDP serialize without frame subscribers or changing explicit screenshot parameters", async t => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  const tab = browserTab(80), native = deferred(), started = deferred();
  let count = 0, active = 0, maximum = 0, previewPrepared = false;
  tab.debugger.sendCommand = async (method, params) => {
    tab.commands.push({ method, params });
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 1700, height: 3500 } };
    assert.equal(method, "Page.captureScreenshot");
    active++; maximum = Math.max(maximum, active);
    if (++count === 1) { started.resolve(); await native.promise; }
    active--;
    return { data: "complete-original-image" };
  };
  // A subscriber call would throw: this fixture intentionally exposes none.
  const context = { sessionId: "owned-chat" };
  const grant = await broker.grant(tab, () => [], context);
  const [target] = await (await fetch(`${grant.browser_url}/json/list`)).json();
  const client = await connect(target.webSocketDebuggerUrl); t.after(() => client.terminate());
  const first = fetch(`${grant.browser_url}/capture`, { method: "POST", headers: { "x-legalwork-browser-session": context.sessionId }, body: JSON.stringify({ fullPage: false }) });
  await started.promise;
  const preview = broker.preview(tab, () => { previewPrepared = true; });
  const params = { format: "webp", quality: 91, captureBeyondViewport: true, clip: { x: 7, y: 11, width: 2300, height: 1900, scale: 0.75 } };
  const raw = command(client, { id: 1, method: "Page.captureScreenshot", params });
  assert.equal(previewPrepared, false);
  assert.equal(count, 1);
  native.resolve();
  const response = await first;
  assert.deepEqual(await response.json(), { mime: "image/png", data: "complete-original-image" });
  assert.equal(await preview, "data:image/png;base64,complete-original-image");
  assert.deepEqual((await raw).result, { data: "complete-original-image" });
  assert.equal(maximum, 1);
  assert.equal(previewPrepared, true);
  const screenshots = tab.commands.filter(item => item.method === "Page.captureScreenshot");
  assert.equal(screenshots[0].params.captureBeyondViewport, false);
  assert.equal(screenshots[0].params.clip, undefined);
  assert.deepEqual(screenshots[1].params.clip, { x: 0, y: 0, width: 1200, height: 800, scale: 0.4 });
  assert.deepEqual(screenshots[2].params, params);
});

test("HTTP Stop restores caller visibility immediately but the next capture waits for the true native reply", async t => {
  const broker = createBrowserAutomationBroker({ authorize: async () => {} });
  t.after(() => broker.close());
  const tab = browserTab(81), native = deferred(), started = deferred(), restored = deferred();
  const controller = new AbortController();
  let calls = 0, active = 0, maximum = 0;
  tab.debugger.sendCommand = async method => {
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 1600, height: 2400 } };
    active++; maximum = Math.max(maximum, active);
    if (++calls === 1) { started.resolve(); await native.promise; }
    active--; return { data: "original-image" };
  };
  const context = { sessionId: "owned-chat" };
  const grant = await broker.grant(tab, () => [], context, undefined, () => () => restored.resolve());
  const options = { method: "POST", headers: { "x-legalwork-browser-session": context.sessionId }, body: "{}" };
  const first = fetch(`${grant.browser_url}/capture`, { ...options, signal: controller.signal });
  await started.promise;
  controller.abort(new Error("User Stop"));
  await assert.rejects(first, /User Stop/);
  await restored.promise;
  const second = fetch(`${grant.browser_url}/capture`, options);
  assert.equal(calls, 1);
  native.resolve();
  const response = await second;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mime: "image/png", data: "original-image" });
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
});

test("a queued screenshot rechecks permission at actual admission and never dispatches after revocation", async t => {
  let allowed = true, starts = 0, denials = 0;
  const broker = createBrowserAutomationBroker({ authorize: async () => {
    if (!allowed) { denials++; throw new Error("Browser access was revoked while queued."); }
  } });
  t.after(() => broker.close());
  const tab = browserTab(82), native = deferred(), started = deferred();
  tab.debugger.sendCommand = async method => {
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 1400, height: 2200 } };
    starts++; started.resolve(); await native.promise; return { data: "complete-image" };
  };
  const context = { sessionId: "owned-chat" };
  const grant = await broker.grant(tab, () => [], context);
  const options = { method: "POST", headers: { "x-legalwork-browser-session": context.sessionId }, body: "{}" };
  const first = fetch(`${grant.browser_url}/capture`, options);
  await started.promise;
  // Direct preview enters the same queue without a second HTTP scheduling race.
  const second = broker.preview(tab);
  const denied = assert.rejects(second, /capability was revoked/);
  allowed = false; native.resolve();
  await denied;
  await (await first).arrayBuffer();
  assert.equal(starts, 1);
  assert.equal(denials, 1);
  assert.equal(tab.isDestroyed(), true);
});
