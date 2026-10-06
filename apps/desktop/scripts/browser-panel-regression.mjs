import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, WebContentsView, clipboard, session } from "electron";
import { createBrowserPanel } from "../electron/browser-panel.mjs";

const userData = mkdtempSync(path.join(os.tmpdir(), "legalwork-browser-test-"));
app.setPath("userData", userData);
app.whenReady().then(() => {
  const main = new BrowserWindow({ show: false });
  const detached = new BrowserWindow({ show: false });
  const panel = createBrowserPanel({
    app, WebContentsView, clipboard, session,
    getWindow: () => main,
    getWindowForEvent: (event) => BrowserWindow.fromWebContents(event.sender),
    isAllowedAppNavigation: () => false,
    safeOpen: { openExternal: async () => false, openPath: async () => "", showItemInFolder: () => {} },
  });
  const handlers = new Map();
  panel.registerIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
  });
  const invoke = (window, method, ...args) => handlers.get(`legalwork:browser:${method}`)(
    { sender: window.webContents }, ...args,
  );
  const mainBounds = { x: 400, y: 100, width: 500, height: 600 };
  const detachedBounds = { x: 300, y: 100, width: 400, height: 500 };
  let exitCode = 0;

  try {
    const { tabId } = invoke(main, "createTab", "about:blank");
    invoke(main, "show", mainBounds);
    const view = main.contentView.children[0];
    assert.ok(view);

    // Both renderers send these updates when the shared conversation changes.
    // Exercise each order because their IPC calls can arrive interleaved.
    for (const order of [[main, detached], [detached, main]]) {
      for (const window of order) {
        assert.equal(invoke(window, "state").activeTabId, tabId);
        assert.equal(invoke(window, "listTabs").length, 1);
        invoke(window, "bounds", window === main ? mainBounds : detachedBounds);
      }
      invoke(detached, "hide");
      assert.deepEqual(main.contentView.children, [view]);
      assert.deepEqual(detached.contentView.children, []);
      assert.deepEqual(view.getBounds(), mainBounds);
    }
    console.log("PASS: background reads, bounds, and cleanup preserve the main page");

    invoke(detached, "show", detachedBounds);
    invoke(main, "bounds", mainBounds);
    invoke(main, "hide");
    invoke(main, "state");
    invoke(main, "listTabs");
    assert.deepEqual(main.contentView.children, []);
    assert.deepEqual(detached.contentView.children, [view]);
    assert.deepEqual(view.getBounds(), detachedBounds);
    console.log("PASS: background updates preserve the detached page");

    invoke(detached, "hide");
    assert.deepEqual(detached.contentView.children, []);
    invoke(detached, "show", detachedBounds);
    assert.deepEqual(detached.contentView.children, [view]);
    console.log("PASS: the owning window can hide and reopen the same page");

    invoke(main, "selectTab", tabId);
    // Selecting changes ownership; the receiving renderer must first report
    // its own geometry. Never flash the previous window's layout.
    assert.deepEqual(main.contentView.children, []);
    assert.deepEqual(detached.contentView.children, []);
    invoke(main, "show", mainBounds, tabId);
    assert.deepEqual(main.contentView.children, [view]);
    assert.deepEqual(detached.contentView.children, []);
    assert.deepEqual(view.getBounds(), mainBounds);
    console.log("PASS: handoff waits for the receiving pane's geometry");

    const secondId = invoke(main, "createTab", "about:blank").tabId;
    const rightBounds = { ...mainBounds, x: 920, width: 350 };
    invoke(main, "show", rightBounds, secondId);
    assert.equal(main.contentView.children.length, 2);
    const secondView = main.contentView.children.find(child => child !== view);
    assert.deepEqual(secondView.getBounds(), rightBounds);
    invoke(main, "bounds", { ...mainBounds, height: 300 }, tabId);
    assert.deepEqual(secondView.getBounds(), rightBounds);
    invoke(main, "hide", tabId);
    assert.deepEqual(main.contentView.children, [secondView]);
    invoke(main, "show", mainBounds, tabId);
    invoke(main, "closeTab", secondId);
    assert.deepEqual(main.contentView.children, [view]);
    console.log("PASS: two real native panes resize, hide and close independently");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    panel.destroy();
    main.destroy();
    detached.destroy();
    app.once("quit", () => rmSync(userData, { recursive: true, force: true }));
    app.exit(exitCode);
  }
});
