import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createBrowserPanel } from "../electron/browser-panel.mjs";

const userData = mkdtempSync(path.join(os.tmpdir(), "legalwork-browser-test-"));
app.setPath("userData", userData);
app.whenReady().then(() => {
  const main = new BrowserWindow({ show: false });
  const detached = new BrowserWindow({ show: false });
  const panel = createBrowserPanel({
    getWindow: () => main,
    getWindowForEvent: (event) => BrowserWindow.fromWebContents(event.sender),
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
    invoke(main, "bounds", mainBounds);
    assert.deepEqual(main.contentView.children, [view]);
    assert.deepEqual(detached.contentView.children, []);
    assert.deepEqual(view.getBounds(), mainBounds);
    console.log("PASS: selecting a tab in another window reattaches its page");
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
