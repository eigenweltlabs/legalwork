import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createAppUrlMatcher, guardIpcMain, isAllowedPreviewNavigation } from "./app-url.mjs";
import { BROWSER_PRELOAD_CHANNELS } from "./browser-panel.mjs";

const macRoot = "/Applications/LegalWork.app/Contents/Resources/app-dist";
const isAppUrl = createAppUrlMatcher({ appRoot: macRoot });
const appFrame = { url: `file://${macRoot}/index.html`, parent: null };
const frameNavigation = (url, parent = appFrame, initiator = parent, currentUrl = "") => ({ url, frame: { url: currentUrl, parent }, initiator });

test("saved-card payments can load Stripe frames directly inside the app", () => {
  for (const url of ["https://js.stripe.com/v3/controller.html", "https://b.js.stripe.com/controller.html", "https://hooks.stripe.com/3d_secure"]) {
    assert.equal(isAllowedPreviewNavigation(frameNavigation(url), { isAppUrl }), true, url);
    assert.equal(isAllowedPreviewNavigation(frameNavigation(url)), false, "payment frames require an app URL matcher");
  }
  const isDevAppUrl = createAppUrlMatcher({ devServerUrl: "http://localhost:5182", appRoot: macRoot });
  assert.equal(isAllowedPreviewNavigation(frameNavigation("https://js.stripe.com/v3/controller.html", { url: "http://localhost:5182/", parent: null }), { isAppUrl: isDevAppUrl }), true);
});

test("Stripe-owned payment frames can load nested bank verification and metrics", () => {
  const stripeFrame = { url: "https://js.stripe.com/v3/controller.html", parent: appFrame };
  const verificationFrame = { url: "https://hooks.stripe.com/3d_secure", parent: stripeFrame };
  const bankFrame = { url: "https://bank.example/challenge", parent: verificationFrame };
  for (const parent of [stripeFrame, verificationFrame, bankFrame]) {
    assert.equal(isAllowedPreviewNavigation(frameNavigation("https://bank.example/verification", parent), { isAppUrl }), true);
    assert.equal(isAllowedPreviewNavigation(frameNavigation("https://m.stripe.network/inner.html", parent), { isAppUrl }), true);
    assert.equal(isAllowedPreviewNavigation(frameNavigation("http://bank.example/verification", parent), { isAppUrl }), false);
  }
});

test("payment exceptions cannot be used by previews or unrelated remote pages", () => {
  const stripeUrl = "https://js.stripe.com/v3/controller.html";
  for (const url of ["about:srcdoc", "blob:null/preview", "https://example.com/", "https://js.stripe.com.evil.example/"]) {
    const previewFrame = { url, parent: appFrame };
    const nestedFrame = { url: "about:blank", parent: previewFrame };
    const stripeInPreview = { url: stripeUrl, parent: previewFrame };
    for (const parent of [previewFrame, nestedFrame, stripeInPreview]) {
      assert.equal(isAllowedPreviewNavigation(frameNavigation(stripeUrl, parent), { isAppUrl }), false, url);
      assert.equal(isAllowedPreviewNavigation(frameNavigation("https://bank.example/challenge", parent), { isAppUrl }), false, url);
    }
  }
  assert.equal(isAllowedPreviewNavigation(frameNavigation(stripeUrl, { url: "https://example.com/", parent: null }), { isAppUrl }), false);
  for (const url of ["about:srcdoc", "blob:null/preview", "about:blank"]) {
    assert.equal(isAllowedPreviewNavigation(frameNavigation(stripeUrl, appFrame, { url, parent: appFrame }, url), { isAppUrl }), false, "preview self-navigation must stay blocked");
  }
  assert.equal(isAllowedPreviewNavigation(frameNavigation(stripeUrl, appFrame, null), { isAppUrl }), false);
  assert.equal(isAllowedPreviewNavigation(frameNavigation(stripeUrl, appFrame, null, stripeUrl), { isAppUrl }), true, "Stripe controllers can reload themselves");
});

test("payment frame URLs require HTTPS, Stripe ownership, and the standard port", () => {
  for (const url of ["https://example.com/", "http://js.stripe.com/", "https://js.stripe.com.evil.example/", "https://evilstripe.com/", "https://js.stripe.com:444/", "https://synthetic-user@js.stripe.com/", "javascript:void(0)", "data:text/html,test", "not a url"]) {
    assert.equal(isAllowedPreviewNavigation(frameNavigation(url), { isAppUrl }), false, url);
  }
});

test("preview navigation stays offline while PDFium can load its own internal stream", () => {
  const viewer = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
  const blocked = (url, parent = "about:srcdoc") => !isAllowedPreviewNavigation({ url, frame: { parent: { url: parent } } });
  assert.equal(blocked("https://example.com/"), true);
  assert.equal(blocked(`${viewer}stream`), true);
  assert.equal(blocked(`${viewer}stream`, `${viewer}index.html`), false);
  assert.equal(blocked("https://example.com/", `${viewer}index.html`), true);
  assert.equal(blocked("blob:null/preview"), false);
});

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
  assert.throws(() => ipc.handlers.get("legalwork:desktop")({ senderFrame: { url: "https://js.stripe.com/v3/controller.html" } }, 21), /outside LegalWork/);
  assert.throws(() => ipc.handlers.get("legalwork:desktop")({ senderFrame: null }, 21), /outside LegalWork/);
  assert.deepEqual(rejected, ["legalwork:desktop", "legalwork:desktop", "legalwork:desktop"]);
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

test("browser preload requests reach panel validation without exposing account selection or the desktop bridge", () => {
  const ipc = fakeIpcMain(), calls = [];
  const guarded = guardIpcMain(ipc, {
    isTrustedUrl: createAppUrlMatcher({ appRoot: macRoot }),
    openChannels: BROWSER_PRELOAD_CHANNELS,
  });
  for (const channel of ["legalwork:autofill:suggest", "legalwork:autofill:dismiss", "legalwork:menu-overlay:choose", "legalwork:desktop"]) {
    guarded.on(channel, () => calls.push(channel));
    ipc.listeners.get(channel)(otherEvent);
  }
  assert.deepEqual(calls, ["legalwork:autofill:suggest", "legalwork:autofill:dismiss"]);
});
