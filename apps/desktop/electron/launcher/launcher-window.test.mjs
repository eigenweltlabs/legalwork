import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { panelWasMoved, placePanel } from "./launcher-placement.mjs";

test("the panel centres on the active display and keeps a remembered position only inside that display", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(placePanel(area, { width: 680, height: 420 }, null), { x: 380, y: 183, width: 680, height: 420 });
  assert.deepEqual(placePanel(area, { width: 680, height: 420 }, { x: 100, y: 200 }), { x: 100, y: 200, width: 680, height: 420 });
  // Off-screen memory (an unplugged display) is repaired instead of trusted.
  assert.deepEqual(placePanel(area, { width: 680, height: 420 }, { x: 3000, y: 200 }), { x: 380, y: 183, width: 680, height: 420 });
  // A display smaller than the panel clamps the size.
  assert.deepEqual(placePanel({ x: 0, y: 0, width: 600, height: 300 }, { width: 680, height: 420 }, null), { x: 0, y: 0, width: 600, height: 300 });
  // Negative-origin displays keep the panel inside their own bounds.
  assert.deepEqual(placePanel({ x: -1920, y: -200, width: 1920, height: 1080 }, { width: 680, height: 420 }, { x: -1500, y: 0 }), { x: -1500, y: 0, width: 680, height: 420 });
});

// Exercise the real lifecycle without opening native windows or starting Electron.
function windowFixture(load = async () => {}) {
  const created = [];
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const display = { id: 1, workArea: area };
  class NativeWindow extends EventEmitter {
    constructor(bounds) {
      super(); this.bounds = bounds; this.destroyed = false; this.visible = false;
      this.webContents = { setWindowOpenHandler() {}, on() {}, send() {} };
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setMenuBarVisibility() {}
    loadFile() { return load(); }
    show() { this.visible = true; }
    focus() {} hide() { this.visible = false; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const source = readFileSync(new URL("./launcher-window.mjs", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export class LauncherWindow", "class LauncherWindow");
  const LauncherWindow = runInNewContext(`${source}\nLauncherWindow`, {
    BrowserWindow: NativeWindow, screen: { getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayMatching: () => display },
    readFile, writeFile, path, process, placePanel, panelWasMoved, setTimeout, clearTimeout,
  });
  const panel = new LauncherWindow({ appRoot: "/tmp", preloadPath: "/tmp/preload", userDataDir: "/tmp", focusedDisplay: () => 1, onVisibility() {}, onExpand() {} });
  panel.positionLoaded = true;
  return { panel, created };
}

test("overlapping first opens share the position read and one native window", async () => {
  const { panel, created } = windowFixture();
  let finishPosition = () => {};
  const position = new Promise(resolve => { finishPosition = () => resolve(undefined); });
  panel.positionLoaded = false;
  panel.loadPosition = async () => { panel.positionLoaded = true; await position; };
  const first = panel.ensure(), second = panel.ensure();
  finishPosition();
  assert.equal(await first, await second);
  assert.equal(created.length, 1);
});

test("a cancelled show stays hidden when its renderer finishes loading", async () => {
  let finishLoading = () => {};
  const loading = new Promise(resolve => { finishLoading = () => resolve(undefined); });
  const { panel, created } = windowFixture(() => loading);
  let wanted = true;
  const showing = panel.show(() => wanted);
  wanted = false;
  finishLoading();
  await showing;
  assert.equal(created[0].visible, false);
});

test("a failed renderer load is destroyed and the next open retries", async () => {
  let attempts = 0;
  const { panel, created } = windowFixture(async () => { if (++attempts === 1) throw new Error("renderer unavailable"); });
  await assert.rejects(panel.ensure(), /renderer unavailable/);
  assert.equal(created[0].destroyed, true);
  await panel.show();
  assert.equal(created.length, 2);
  assert.equal(created[1].visible, true);
});

test("disposing during the position read cannot create a late native window", async () => {
  const { panel, created } = windowFixture();
  let finishPosition = () => {};
  const position = new Promise(resolve => { finishPosition = () => resolve(undefined); });
  panel.positionLoaded = false;
  panel.loadPosition = async () => { panel.positionLoaded = true; await position; };
  const loading = panel.ensure();
  panel.destroy();
  finishPosition();
  await assert.rejects(loading, /closed/);
  assert.equal(created.length, 0);
});

test("turning off remembered placement opens at the default without forgetting the saved position", async () => {
  const { panel } = windowFixture();
  panel.positions["1"] = { x: 100, y: 200, displayId: 1 };
  panel.rememberPosition = false;
  await panel.show();
  assert.equal(panel.window.getBounds().x, 440);
  assert.equal(panel.window.getBounds().y, 183);
  panel.hide();
  panel.rememberPosition = true;
  await panel.show();
  assert.equal(panel.window.getBounds().x, 100);
  assert.equal(panel.window.getBounds().y, 200);
});

test("the reset control appears only after the panel leaves its default position", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const compact = placePanel(area, { width: 560, height: 346 }, null);
  assert.deepEqual(compact, { x: 440, y: 183, width: 560, height: 346 });
  assert.equal(panelWasMoved(area, compact), false);
  assert.equal(panelWasMoved(area, { ...compact, height: 520 }), false);
  assert.equal(panelWasMoved(area, { ...compact, x: compact.x + 20 }), true);
  assert.equal(panelWasMoved(area, { ...compact, y: compact.y - 20 }), true);
});
