import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { panelWasMoved, placePanel } from "./launcher-placement.mjs";

const PANEL_WIDTH = 560;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 720;
const DEFAULT_HEIGHT = 346;
const EVENT = "legalwork:launcher:event";

/**
 * The focusable quick panel. A separate window from the non-focusable
 * companion: it takes typing focus, grows with its content, can be pinned,
 * and hides on blur unless a preview, menu or dialog of its own is open.
 */
export class LauncherWindow {
  /**
   * @param {{ appRoot: string, startUrl?: string, preloadPath: string, icon?: import("electron").NativeImage | null, userDataDir: string, focusedDisplay: () => number | null,
   *   onVisibility: (state: { visible: boolean, pinned: boolean }) => void, onExpand: (route: string) => void, onFocusChange?: (focused: boolean) => void }} options
   */
  constructor(options) {
    this.options = options;
    /** @type {BrowserWindow | null} */
    this.window = null;
    this.disposed = false;
    /** @type {Promise<BrowserWindow> | null} */
    this.loading = null;
    this.pinned = false;
    this.height = DEFAULT_HEIGHT;
    this.rememberPosition = true;
    this.positionPath = path.join(options.userDataDir, "launcher-position.json");
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.blurTimer = null;
    this.childDialogs = 0;
    /** @type {number | null} */
    this.displayId = null;
    /** @type {{ x: number, y: number, displayId: number | null } | null} */
    this.remembered = null;
    /** @type {Record<string, { x: number, y: number, displayId: number | null }>} */
    this.positions = {};
    this.positionLoaded = false;
    this.positionWrite = Promise.resolve();
  }
  isVisible() { return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()); }
  isFocused() { return Boolean(this.window && !this.window.isDestroyed() && this.window.isFocused()); }
  positionMoved() {
    if (!this.window || this.window.isDestroyed()) return false;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    return panelWasMoved(area, bounds);
  }
  state() { return { visible: this.isVisible(), pinned: this.pinned, focused: this.isFocused(), displayId: this.displayId, moved: this.positionMoved() }; }
  webContents() { return this.window && !this.window.isDestroyed() ? this.window.webContents : null; }
  send(event) { this.webContents()?.send(EVENT, event); }
  async loadPosition() {
    this.positionLoaded = true;
    try {
      const saved = JSON.parse(await readFile(this.positionPath, "utf8"));
      for (const position of saved?.positions ? Object.values(saved.positions) : saved ? [saved] : []) {
        if (position && typeof position === "object" && "x" in position && "y" in position && "displayId" in position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
          this.positions[String(position.displayId)] = position;
        }
      }
    } catch { /* no saved position */ }

  }
  savePosition() {
    if (!this.rememberPosition || !this.window || this.window.isDestroyed()) return;
    const [x, y] = this.window.getPosition();
    this.displayId = screen.getDisplayMatching(this.window.getBounds()).id;
    this.remembered = { x, y, displayId: this.displayId };
    this.positions[String(this.displayId)] = this.remembered;
    const saved = JSON.stringify({ positions: this.positions });
    this.positionWrite = this.positionWrite.then(() => writeFile(this.positionPath, saved)).catch(() => {});
  }
  display() {
    const focused = this.options.focusedDisplay();
    return screen.getAllDisplays().find(display => display.id === focused) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  /** Keep the renderer warm only when asked (background presence); otherwise it is created on first use. */
  async ensure() {
    if (this.disposed) throw new Error("The launcher has been closed.");
    if (this.loading) return this.loading;
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.loading = this.createWindow().finally(() => { this.loading = null; });
    return this.loading;
  }
  async createWindow() {
    if (!this.positionLoaded) await this.loadPosition();
    if (this.disposed) throw new Error("The launcher has been closed.");
    const window = new BrowserWindow({
      ...placePanel(this.display().workArea, { width: PANEL_WIDTH, height: this.height }, this.remembered),
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      frame: false, transparent: process.platform !== "linux", resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
      hasShadow: false, backgroundColor: "#00000000", alwaysOnTop: true, title: "LegalWork Assistant",
      ...(this.options.icon && !this.options.icon.isEmpty() ? { icon: this.options.icon } : {}),
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.window = window;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.on("blur", () => {
      this.options.onFocusChange?.(false);
      // Menus, previews and file choosers must not dismiss the panel; a pinned panel never auto-hides.
      if (this.pinned || this.childDialogs > 0) return;
      if (this.blurTimer) clearTimeout(this.blurTimer);
      this.blurTimer = setTimeout(() => { if (!this.pinned && this.childDialogs === 0 && this.isVisible() && !this.isFocused()) this.hide(); }, 120);
    });
    window.on("focus", () => { this.options.onFocusChange?.(true); if (this.blurTimer) clearTimeout(this.blurTimer); });
    window.on("moved", () => { this.savePosition(); this.send({ type: "position", moved: this.positionMoved() }); });
    window.on("closed", () => { if (this.window === window) this.window = null; });
    const route = "/launcher";
    try {
      await (this.options.startUrl ? window.loadURL(`${this.options.startUrl}#${route}`) : window.loadFile(path.join(this.options.appRoot, "index.html"), { hash: route }));
      if (window.isDestroyed()) throw new Error("The launcher closed while loading.");
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    return window;
  }
  /** @param {() => boolean} [shouldShow] */
  async show(shouldShow = () => true) {
    const window = await this.ensure();
    if (!shouldShow()) return this.state();
    const display = this.display();
    this.displayId = display.id;
    this.remembered = this.rememberPosition ? this.positions[String(display.id)] ?? null : null;
    const bounds = placePanel(display.workArea, { width: PANEL_WIDTH, height: this.height }, this.remembered?.displayId === display.id || !this.remembered?.displayId ? this.remembered : null);
    window.setBounds(bounds);
    window.show();
    window.focus();
    this.options.onVisibility({ visible: true, pinned: this.pinned });
    this.send({ type: "visibility", visible: true, pinned: this.pinned });
    this.send({ type: "position", moved: this.positionMoved() });
    return this.state();
  }
  async resetPosition() {
    const window = await this.ensure();
    const display = screen.getDisplayMatching(window.getBounds());
    this.displayId = display.id;
    this.remembered = null;
    delete this.positions[String(display.id)];
    const saved = JSON.stringify({ positions: this.positions });
    this.positionWrite = this.positionWrite.then(() => writeFile(this.positionPath, saved)).catch(() => {});
    await this.positionWrite;
    window.setBounds(placePanel(display.workArea, { width: PANEL_WIDTH, height: this.height }, null));
    this.send({ type: "position", moved: this.positionMoved() });
    return this.state();
  }
  hide() {
    if (this.blurTimer) clearTimeout(this.blurTimer);
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide();
      this.height = DEFAULT_HEIGHT;
      this.options.onVisibility({ visible: false, pinned: this.pinned });
      this.send({ type: "visibility", visible: false, pinned: this.pinned });
    }
    return this.state();
  }
  async toggle() { return this.isVisible() && this.isFocused() ? this.hide() : this.show(); }
  setPinned(pinned) {
    this.pinned = Boolean(pinned);
    this.send({ type: "visibility", visible: this.isVisible(), pinned: this.pinned });
    return this.state();
  }
  resize(height) {
    const next = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Number(height) || DEFAULT_HEIGHT)));
    this.height = next;
    if (this.window && !this.window.isDestroyed()) {
      const bounds = this.window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const height = Math.min(next, area.height);
      this.window.setBounds({ ...bounds, height, y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
    }
    return this.state();
  }
  /** Temporarily leave the screen for a capture, then come back. */
  async hiddenWhile(work) {
    const wasVisible = this.isVisible();
    if (wasVisible) { this.childDialogs++; this.window?.hide(); }
    try { return await work(); }
    finally { if (wasVisible) { this.childDialogs--; await this.show(); } }
  }
  beginDialog() { this.childDialogs++; }
  endDialog() { this.childDialogs = Math.max(0, this.childDialogs - 1); if (this.isVisible() && !this.pinned && !this.isFocused()) this.window?.focus(); }
  expand(route) { this.hide(); this.options.onExpand(route); }
  destroy() {
    this.disposed = true;
    if (this.blurTimer) clearTimeout(this.blurTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
