import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createAppUrlMatcher, guardIpcMain } from "./app-url.mjs";

const macRoot = "/Applications/LegalWork.app/Contents/Resources/app-dist";

test("packaged app matches only files inside app-dist", () => {
  const isAppUrl = createAppUrlMatcher({ appRoot: macRoot });
  assert.equal(isAppUrl(`file://${macRoot}/index.html`), true);
  assert.equal(isAppUrl(`file://${macRoot}/index.html#/session/abc`), true);
  assert.equal(isAppUrl(`file://${macRoot}/overlay.html`), true);
  assert.equal(isAppUrl(`file://${macRoot}`), false);
  assert.equal(isAppUrl(`file://${macRoot}-other/index.html`), false);
  assert.equal(isAppUrl(`file://${macRoot}/../index.html`), false);
  assert.equal(isAppUrl("file:///Users/someone/Documents/notes.html"), false);
  assert.equal(isAppUrl("https://example.com/"), false);
  assert.equal(isAppUrl("data:text/html,hello"), false);
  assert.equal(isAppUrl("about:blank"), false);
  assert.equal(isAppUrl(""), false);
  assert.equal(isAppUrl(undefined), false);
  assert.equal(isAppUrl("not a url"), false);
});

test("dev server mode matches only the dev server origin", () => {
  const isAppUrl = createAppUrlMatcher({ devServerUrl: "http://localhost:5173/", appRoot: macRoot });
  assert.equal(isAppUrl("http://localhost:5173/"), true);
  assert.equal(isAppUrl("http://localhost:5173/overlay.html"), true);
  assert.equal(isAppUrl("http://localhost:5173/#/settings"), true);
  assert.equal(isAppUrl("http://localhost:5174/"), false);
  assert.equal(isAppUrl("https://localhost:5173/"), false);
  assert.equal(isAppUrl(`file://${macRoot}/index.html`), false);
});

test("windows paths compare by folder, case-insensitively", () => {
  const isAppUrl = createAppUrlMatcher({
    appRoot: "C:\\Program Files\\LegalWork\\resources\\app-dist",
    pathApi: path.win32,
  });
  assert.equal(isAppUrl("file:///C:/Program%20Files/LegalWork/resources/app-dist/index.html"), true);
  assert.equal(isAppUrl("file:///c:/program%20files/legalwork/resources/app-dist/index.html"), true);
  assert.equal(isAppUrl("file:///D:/app-dist/index.html"), false);
  assert.equal(isAppUrl("file://server/share/app-dist/index.html"), false);
});

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
}

const appEvent = { senderFrame: { url: `file://${macRoot}/index.html` } };
const otherEvent = { senderFrame: { url: "https://example.com/" } };

test("guarded handlers run only for app pages", async () => {
  const ipc = fakeIpcMain();
  const rejected = [];
  const guarded = guardIpcMain(ipc, {
    isTrustedUrl: createAppUrlMatcher({ appRoot: macRoot }),
    onRejected: (channel) => rejected.push(channel),
  });
  guarded.handle("legalwork:desktop", (_event, value) => value * 2);

  assert.equal(await ipc.handlers.get("legalwork:desktop")(appEvent, 21), 42);
  assert.throws(() => ipc.handlers.get("legalwork:desktop")(otherEvent, 21), /outside LegalWork/);
  assert.throws(() => ipc.handlers.get("legalwork:desktop")({ senderFrame: null }, 21), /outside LegalWork/);
  assert.deepEqual(rejected, ["legalwork:desktop", "legalwork:desktop"]);
});

test("guarded listeners ignore other pages, open channels accept everyone", () => {
  const ipc = fakeIpcMain();
  const calls = [];
  const guarded = guardIpcMain(ipc, {
    isTrustedUrl: createAppUrlMatcher({ appRoot: macRoot }),
    openChannels: ["legalwork:menu-overlay:dismiss"],
  });
  guarded.on("legalwork:audio:pcm", () => calls.push("pcm"));
  guarded.on("legalwork:menu-overlay:dismiss", () => calls.push("dismiss"));

  ipc.listeners.get("legalwork:audio:pcm")(otherEvent);
  ipc.listeners.get("legalwork:audio:pcm")(appEvent);
  ipc.listeners.get("legalwork:menu-overlay:dismiss")(otherEvent);
  assert.deepEqual(calls, ["pcm", "dismiss"]);
});
