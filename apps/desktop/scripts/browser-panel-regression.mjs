import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, WebContentsView, clipboard, session } from "electron";
import { createBrowserPanel } from "../electron/browser-panel.mjs";

const userData = mkdtempSync(path.join(os.tmpdir(), "legalwork-browser-test-"));
app.setPath("userData", userData);
app.whenReady().then(async () => {
  const main = new BrowserWindow({ show: false });
  const detached = new BrowserWindow({ show: false });
  const panel = createBrowserPanel({
    app, WebContentsView, clipboard, session,
    getWindow: () => main,
    getWindowForEvent: (event) => BrowserWindow.fromWebContents(event.sender),
    isAllowedAppNavigation: () => false,
    safeOpen: { openExternal: async () => false, openPath: async () => "", showItemInFolder: () => {} },
    resolveDownloadDirectory: async () => null,
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
    const { tabId } = await invoke(main, "createTab", "about:blank");
    invoke(main, "show", mainBounds, tabId);
    const view = main.contentView.children[0];
    assert.ok(view);

    // Other app windows see no tabs until their layout explicitly creates copies.
    assert.equal(invoke(detached, "state").tabs.length, 0);
    invoke(detached, "show", detachedBounds, tabId);
    invoke(detached, "bounds", detachedBounds, tabId);
    invoke(detached, "hide", tabId);
    assert.deepEqual(main.contentView.children, [view]);
    assert.deepEqual(detached.contentView.children, []);
    console.log("PASS: another window cannot adopt or move the original tab");

    const copyId = (await invoke(detached, "createTab", "about:blank")).tabId;
    invoke(detached, "show", detachedBounds, copyId);
    const copyView = detached.contentView.children[0];
    assert.ok(copyView);
    assert.notEqual(copyId, tabId);
    assert.deepEqual(main.contentView.children, [view]);
    assert.deepEqual(detached.contentView.children, [copyView]);
    assert.deepEqual(copyView.getBounds(), detachedBounds);
    assert.equal(invoke(main, "state").tabs.length, 1);
    assert.equal(invoke(detached, "state").tabs.length, 1);
    console.log("PASS: both windows show independent native browsers at once");

    invoke(detached, "hide", copyId);
    assert.deepEqual(detached.contentView.children, []);
    invoke(detached, "show", detachedBounds, copyId);
    assert.deepEqual(detached.contentView.children, [copyView]);
    invoke(detached, "closeAllTabs");
    assert.equal(invoke(detached, "state").tabs.length, 0);
    assert.equal(invoke(main, "state").tabs.length, 1);
    assert.deepEqual(main.contentView.children, [view]);
    console.log("PASS: closing copied browsers leaves originals open");

    const secondId = (await invoke(main, "createTab", "about:blank")).tabId;
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
