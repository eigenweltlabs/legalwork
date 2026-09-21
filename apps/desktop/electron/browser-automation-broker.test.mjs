import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { createBrowserAutomationBroker } from "./browser-automation-broker.mjs";

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
    debugger: Object.assign(new EventEmitter(), {
      attach: () => { assert.equal(tab.attached, false); tab.attached = true; },
      detach: () => { tab.attached = false; tab.emit("debugger-detached"); },
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

test("discovery and WebSocket upgrades require a tab capability and reject web origins", async (t) => {
  const broker = createBrowserAutomationBroker();
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
  const broker = createBrowserAutomationBroker();
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
  const broker = createBrowserAutomationBroker();
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
  const broker = createBrowserAutomationBroker();
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
