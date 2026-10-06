import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBrowserPanel } from "./browser-panel.mjs";

function fixture() {
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
  const window = focused => ({
    focused, isDestroyed: () => false, isFocused() { return this.focused; },
    webContents: { isDestroyed: () => false, send: () => {}, getZoomFactor: () => 1.25 },
    contentView: { children: [], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(child => child !== view); } },
  });
  const first = window(true), second = window(false);
  const handlers = new Map();
  const controller = createBrowserPanel({ app: new EventEmitter(), WebContentsView: View, clipboard: { writeText: () => {} }, session: { fromPartition: () => ({}) },
    getWindow: () => first, getWindowForEvent: event => event.sender === first.webContents ? first : second,
    isAllowedAppNavigation: () => true, safeOpen: { openExternal: () => {} },
  });
  controller.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on: () => {} });
  const call = (name, host, ...args) => handlers.get(`legalwork:browser:${name}`)({ sender: host.webContents }, ...args);
  const left = { x: 20, y: 50, width: 400, height: 600 }, right = { ...left, x: 425 };
  return { controller, views, first, second, call, left, right };
}

test("native browser panes keep separate bounds, navigation and visibility", t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const a = f.call("createTab", f.first, "https://example.com").tabId;
  const b = f.call("createTab", f.first, "https://example.org").tabId;
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

test("background windows cannot steal panes or move their host's bounds", t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const a = f.call("createTab", f.first, "about:blank").tabId;
  f.call("show", f.first, f.left, a);
  const bounds = f.views[0].bounds;
  f.call("show", f.second, f.right, a);
  f.call("bounds", f.second, f.right, a);
  f.call("hide", f.second, a);
  assert.deepEqual(f.first.contentView.children, [f.views[0]]);
  assert.deepEqual(f.views[0].bounds, bounds);
  f.first.focused = false; f.second.focused = true;
  f.call("show", f.second, f.right, a);
  assert.equal(f.first.contentView.children.length, 0);
  assert.deepEqual(f.second.contentView.children, [f.views[0]]);
  f.call("bounds", f.first, f.left, a);
  assert.notDeepEqual(f.views[0].bounds, bounds);
});

test("bad geometry and late resize reports never resurrect a hidden pane", t => {
  const f = fixture(); t.after(() => f.controller.destroy());
  const a = f.call("createTab", f.first, "about:blank").tabId;
  for (const bounds of [null, {}, { ...f.left, width: NaN }, { ...f.left, x: Infinity }, { ...f.left, height: -1 }]) f.call("show", f.first, bounds, a);
  assert.equal(f.first.contentView.children.length, 0);
  f.call("show", f.first, f.left, a);
  f.call("hide", f.first);
  f.call("bounds", f.first, f.left, a);
  assert.equal(f.first.contentView.children.length, 0);
});
