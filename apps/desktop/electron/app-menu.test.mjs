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

test("numbered tab accelerators route to the invoking window on every platform", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const f = fixture(platform);
    const sent = [];
    const target = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
    const view = f.getInstalled().items.find(item => item.label === "View");
    const select = view.submenu.items.find(item => item.label === "Select Tab");
    assert.equal(select.submenu.length, 9);
    for (let number = 1; number <= 9; number++) {
      const item = select.submenu[number - 1];
      assert.equal(item.accelerator, `CommandOrControl+${number}`);
      assert.equal(item.label, number === 9 ? "Last Tab" : `Tab ${number}`);
      item.click(null, target);
      await Promise.resolve();
      assert.deepEqual(sent.at(-1), ["legalwork:native-menu:select-tab", number]);
    }
    assert.deepEqual(f.messages, []);
    select.submenu[0].click(null, { isDestroyed: () => true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.messages, [["legalwork:native-menu:select-tab", 1]]);
  }
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
