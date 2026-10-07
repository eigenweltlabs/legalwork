import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Replace only Electron's import so the real factory can run without a GUI.
const source = readFileSync(new URL("./app-menu.mjs", import.meta.url), "utf8")
  .replace('import { BrowserWindow, Menu } from "electron";', "")
  .replace("export function createApplicationMenu", "function createApplicationMenu");

function fixture(platform) {
  const popups = [];
  const visibility = [];
  const messages = [];
  const window = {
    isDestroyed: () => false,
    setAutoHideMenuBar: () => {},
    setMenuBarVisibility: (value) => visibility.push(value),
    webContents: { getZoomFactor: () => 1.25, send: (...args) => messages.push(args) },
  };
  let installed;
  const Menu = {
    buildFromTemplate: (template) => ({ items: template.map((item) => ({
      ...item,
      label: item.label ?? (item.role === "help" ? "Help" : ""),
      submenu: { items: item.submenu, popup: (options) => popups.push({ label: item.label ?? "Help", ...options }) },
    })) }),
    setApplicationMenu: (value) => { installed = value; },
    getApplicationMenu: () => installed,
  };
  const BrowserWindow = { getFocusedWindow: () => window, getAllWindows: () => [window] };
  const create = runInNewContext(`${source}\ncreateApplicationMenu`, { Menu, BrowserWindow, process: { platform } });
  const menu = create({ appName: "LegalWork", getWindow: async () => window });
  menu.install();
  return { menu, window, popups, visibility, messages, getInstalled: () => installed };
}

test("every Windows title-bar menu opens the installed submenu in the invoking window at its zoomed anchor", async () => {
  const f = fixture("win32");
  for (const label of ["File", "Edit", "View", "Help"]) {
    assert.equal(f.menu.popup(f.window, label, { x: 100, y: 44 }), true);
    const opened = f.popups.at(-1);
    assert.equal(opened.label, label);
    assert.equal(opened.window, f.window);
    assert.equal(opened.x, 125);
    assert.equal(opened.y, 55);
  }
  const edit = f.getInstalled().items.find((item) => item.label === "Edit");
  assert.ok(edit.submenu.items.some((item) => item.role === "copy"));
  const view = f.getInstalled().items.find((item) => item.label === "View");
  const toggle = view.submenu.items.find((item) => item.label === "Toggle Sidebar");
  assert.equal(toggle.accelerator, "CommandOrControl+B");
  toggle.click();
  await Promise.resolve();
  assert.equal(f.messages[0][0], "legalwork:native-menu:toggle-sidebar");
});

test("Windows never adds a second native menu row, including when visibility is requested", () => {
  const f = fixture("win32");
  f.menu.applyVisibility(f.window);
  f.menu.setVisible(true);
  assert.deepEqual(f.visibility, [false, false]);
  const linux = fixture("linux");
  linux.menu.setVisible(true);
  assert.deepEqual(linux.visibility, [true]);
  const mac = fixture("darwin");
  mac.menu.applyVisibility(mac.window);
  assert.deepEqual(mac.visibility, []);
});

test("menu popups reject invalid names, geometry, destroyed windows and other platforms", () => {
  const f = fixture("win32");
  assert.equal(f.menu.popup(f.window, "Unknown", { x: 0, y: 44 }), false);
  assert.equal(f.menu.popup(f.window, "File", { x: NaN, y: 44 }), false);
  assert.equal(f.menu.popup(f.window, "File", null), false);
  assert.equal(f.menu.popup({ isDestroyed: () => true }, "File", { x: 0, y: 44 }), false);
  assert.equal(fixture("linux").menu.popup(f.window, "File", { x: 0, y: 44 }), false);
  assert.equal(f.popups.length, 0);
});
