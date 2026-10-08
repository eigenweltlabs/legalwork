import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserPanel } from "./browser-panel.mjs";
import { resolveBrowserProject } from "./browser-project.mjs";

function fixture(resolveDownloadDirectory = async () => null) {
  const views = [];
  class View {
    constructor() {
      const contents = Object.assign(new EventEmitter(), {
        url: "about:blank", closed: false, reloads: 0,
        loadURL: async url => { contents.url = url; },
        getURL: () => contents.url, getTitle: () => "Test page", isLoading: () => false,
        canGoBack: () => false, canGoForward: () => false,
        reload: () => contents.reloads++, setWindowOpenHandler: () => {},
        isDestroyed: () => contents.closed,
        close: () => { contents.closed = true; contents.emit("destroyed"); },
      });
      this.webContents = contents;
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const window = focused => Object.assign(new EventEmitter(), {
    focused, isDestroyed: () => false, isFocused() { return this.focused; },
    webContents: { messages: [], url: "file:///app/index.html", getURL() { return this.url; }, isDestroyed: () => false, send(channel, payload) { this.messages.push({ channel, payload }); }, getZoomFactor: () => 1.25 },
    contentView: { children: [], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(child => child !== view); } },
  });
  const first = window(true), second = window(false), third = window(false);
  const handlers = new Map();
  const browserSession = new EventEmitter();
  const controller = createBrowserPanel({ app: new EventEmitter(), WebContentsView: View, clipboard: { writeText: () => {} }, session: { fromPartition: () => browserSession },
    getWindow: () => first, getWindowForEvent: event => [first, second, third].find(host => event.sender === host.webContents),
    resolveDownloadDirectory,
    isAllowedAppNavigation: () => true, safeOpen: { openExternal: () => {} },
  });
  controller.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on: () => {} });
  const call = (name, host, ...args) => handlers.get(`legalwork:browser:${name}`)({ sender: host.webContents }, ...args);
  const left = { x: 20, y: 50, width: 400, height: 600 }, right = { ...left, x: 425 };
  return { controller, views, first, second, third, call, left, right, browserSession };
}

test("native browser panes keep separate bounds, navigation and visibility", async t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const a = (await f.call("createTab", f.first, "https://example.com")).tabId;
  const b = (await f.call("createTab", f.first, "https://example.org")).tabId;
  f.call("show", f.first, f.left, a); f.call("show", f.first, f.right, b);
  assert.equal(f.first.contentView.children.length, 2);
  assert.deepEqual(f.views[0].bounds, { x: 25, y: 63, width: 500, height: 750 });
  const otherBounds = f.views[1].bounds;
  f.call("bounds", f.first, { ...f.left, width: 350 }, a);
  assert.deepEqual(f.views[1].bounds, otherBounds);
  f.call("navigate", f.first, "https://example.com/changed", a);
  f.call("reload", f.first, a);
  assert.equal(f.views[0].webContents.url, "https://example.com/changed");
  assert.equal(f.views[0].webContents.reloads, 1);
  assert.equal(f.views[1].webContents.reloads, 0);
  f.views[0].webContents.emit("focus");
  assert.equal(f.call("state", f.first).activeTabId, a);
  f.call("hide", f.first, a);
  assert.deepEqual(f.first.contentView.children, [f.views[1]]);
  f.call("bounds", f.first, f.left, a);
  assert.deepEqual(f.first.contentView.children, [f.views[1]]);
  f.call("show", f.first, f.left, a);
  f.call("closeTab", f.first, b);
  assert.deepEqual(f.first.contentView.children, [f.views[0]]);
});

test("background windows cannot steal panes or move their host's bounds", async t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const a = (await f.call("createTab", f.first, "about:blank")).tabId;
  f.call("show", f.first, f.left, a);
  const bounds = f.views[0].bounds;
  f.call("show", f.second, f.right, a);
  f.call("bounds", f.second, f.right, a);
  f.call("hide", f.second, a);
  assert.deepEqual(f.first.contentView.children, [f.views[0]]);
  assert.deepEqual(f.views[0].bounds, bounds);
  f.first.focused = false; f.second.focused = true;
  f.call("show", f.second, f.right, a);
  assert.deepEqual(f.first.contentView.children, [f.views[0]]);
  assert.deepEqual(f.second.contentView.children, []);
  assert.equal(f.call("state", f.second).tabs.length, 0);
  assert.throws(() => f.call("selectTab", f.second, a), /Unknown browser tab/);
  f.call("closeTab", f.second, a);
  assert.equal(f.call("state", f.first).tabs.length, 1);
});

test("bad geometry and late resize reports never resurrect a hidden pane", async t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const a = (await f.call("createTab", f.first, "about:blank")).tabId;
  for (const bounds of [null, {}, { ...f.left, width: NaN }, { ...f.left, x: Infinity }, { ...f.left, height: -1 }]) f.call("show", f.first, bounds, a);
  assert.equal(f.first.contentView.children.length, 0);
  f.call("show", f.first, f.left, a);
  f.call("hide", f.first);
  f.call("bounds", f.first, f.left, a);
  assert.equal(f.first.contentView.children.length, 0);
});

test("reordering one strip leaves other panes in place and rejects stale orders atomically", async t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await f.call("createTab", f.first, "about:blank")).tabId);
  const order = () => f.call("state", f.first).tabs.map(tab => tab.id);
  f.call("reorderTabs", f.first, [ids[2], ids[0]]);
  assert.deepEqual(order(), [ids[2], ids[1], ids[0], ids[3]]);
  f.call("reorderTabs", f.first, []);
  assert.deepEqual(order(), [ids[2], ids[1], ids[0], ids[3]]);
  assert.throws(() => f.call("reorderTabs", f.first, [ids[2], ids[2]]), /duplicate/);
  f.call("closeTab", f.first, ids[2]);
  assert.throws(() => f.call("reorderTabs", f.first, [ids[0], ids[2]]), /unknown/);
  assert.deepEqual(order(), [ids[1], ids[0], ids[3]]);
});

test("three windows keep independent tabs, events and close-all operations", async t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const original = (await f.call("createTab", f.first, "https://example.com/source")).tabId;
  const copy = (await f.call("createTab", f.second, "https://example.com/source")).tabId;
  const third = (await f.call("createTab", f.third, "https://example.com/third")).tabId;
  assert.equal(new Set([original, copy, third]).size, 3);
  for (const [host, id] of [[f.first, original], [f.second, copy], [f.third, third]]) {
    assert.deepEqual(f.call("listTabs", host).map(tab => tab.id), [id]);
    f.call("show", host, f.left, id);
    assert.equal(host.contentView.children.length, 1);
  }
  const originalEvents = f.first.webContents.messages.length;
  f.call("navigate", f.second, "https://example.com/changed", copy);
  f.views[1].webContents.emit("did-navigate");
  assert.equal(f.first.webContents.messages.length, originalEvents);
  assert.equal(f.second.webContents.messages.at(-1).payload.tabs[0].url, "https://example.com/changed");
  f.call("closeAllTabs", f.second);
  assert.equal(f.call("state", f.second).tabs.length, 0);
  assert.equal(f.call("state", f.first).tabs.length, 1);
  assert.equal(f.call("state", f.third).tabs.length, 1);
});

test("closing a native window destroys only its browser views", async t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  await f.call("createTab", f.first, "about:blank");
  await f.call("createTab", f.second, "about:blank");
  f.second.emit("closed");
  assert.equal(f.views[1].webContents.isDestroyed(), true);
  assert.equal(f.views[0].webContents.isDestroyed(), false);
  await f.call("createTab", f.third, "about:blank");
  assert.equal(f.call("state", f.third).tabs.length, 1);
  f.controller.destroy(f.first);
  assert.equal(f.views[2].webContents.isDestroyed(), false);
});

test("shared browser cookies do not mix download destinations or retain closed-window handlers", async t => {
  const firstRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "legalwork-download-a-")));
  const secondRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "legalwork-download-b-")));
  const projects = { selectedId: "second", workspaces: [
    { id: "first", workspaceType: "local", path: firstRoot },
    { id: "second", workspaceType: "local", path: secondRoot },
  ] };
  const f = fixture((context, windowUrl) => resolveBrowserProject(context, projects, { running: false }, windowUrl));
  f.first.webContents.url = "file:///app/index.html#/workspace/first/session/chat-a";
  f.second.webContents.url = "file:///app/index.html#/workspace/second/session/chat-b";
  t.after(() => {
    f.controller.destroy();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  });
  await f.call("createTab", f.first, "about:blank");
  projects.selectedId = "first";
  await f.call("createTab", f.second, "about:blank");
  assert.equal(f.browserSession.listenerCount("will-download"), 2);
  for (const [index, root] of [firstRoot, secondRoot].entries()) {
    const paths = [];
    const item = Object.assign(new EventEmitter(), {
      getFilename: () => "record.txt", getTotalBytes: () => 1,
      setSavePath: destination => paths.push(destination),
      cancel: () => assert.fail("The other window must not cancel this download"),
    });
    f.browserSession.emit("will-download", {}, item, f.views[index].webContents);
    assert.deepEqual(paths, [path.join(root, "Downloads", "record.txt")]);
  }
  f.second.emit("closed");
  assert.equal(f.browserSession.listenerCount("will-download"), 1);
  f.controller.destroy();
  assert.equal(f.browserSession.listenerCount("will-download"), 0);
});

test("a window without a project route cannot borrow another window's download folder", async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "legalwork-browser-project-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { selectedId: "a", workspaces: [{ id: "a", workspaceType: "local", path: root }] };
  const server = { running: false };
  assert.equal(await resolveBrowserProject({}, state, server, "file:///app/index.html#/evals"), null);
  assert.equal(await resolveBrowserProject({}, state, server, "file:///app/index.html#/workspace/missing/session"), null);
  assert.equal(await resolveBrowserProject({}, state, server, "http://localhost:5188/workspace/a/session"), root);
  assert.equal(await resolveBrowserProject({ directory: root }, state, server, "file:///app/index.html#/evals"), root);
});
