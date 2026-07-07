/**
 * Call overlay — a small frameless always-on-top window with live captions
 * and an AI copilot box, meant to float over Zoom/Teams/Meet during a call.
 *
 * Cluely-style discretion: `setContentProtection(true)` keeps the overlay
 * out of screen shares and recordings, and it lives on all workspaces at
 * screen-saver level so it survives full-screen meeting apps.
 *
 * The overlay renderer is a dedicated Vite entry (`live-overlay.html`).
 * It talks over two channels: `legalwork:audio:event` (the same recorder
 * event feed the main window gets) and `legalwork:audio:ask` for questions
 * typed by the lawyer, which the main window answers through its session AI.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, screen } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OVERLAY_HTML = "live-overlay.html";
const OVERLAY_WIDTH = 420;
const OVERLAY_HEIGHT = 380;

export class CallOverlay {
  /**
   * @param {{ getMainWindow: () => import('electron').BrowserWindow | null,
   *           onCreated: (window: import('electron').BrowserWindow) => void,
   *           onVisibilityChange: (visible: boolean) => void }} options
   */
  constructor(options) {
    this.getMainWindow = options.getMainWindow;
    this.onCreated = options.onCreated;
    this.onVisibilityChange = options.onVisibilityChange;
    /** @type {import('electron').BrowserWindow | null} */
    this.window = null;
  }

  isVisible() {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  async setVisible(visible) {
    if (!visible) {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      this.onVisibilityChange(false);
      return { visible: false };
    }
    const window = await this.ensureWindow();
    window.showInactive();
    this.onVisibilityChange(true);
    return { visible: true };
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const window = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      x: workArea.x + workArea.width - OVERLAY_WIDTH - 24,
      y: workArea.y + 24,
      frame: false,
      transparent: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "call-overlay-preload.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });

    // Float above full-screen meeting apps, follow the user across Spaces,
    // and stay invisible to screen sharing.
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.onVisibilityChange(false);
      }
    });

    this.window = window;
    this.onCreated(window);
    await this.loadRenderer(window);
    return window;
  }

  async loadRenderer(window) {
    const mainUrl = this.getMainWindow()?.webContents?.getURL?.();
    if (mainUrl && /^https?:\/\//i.test(mainUrl)) {
      await window.loadURL(new URL(OVERLAY_HTML, mainUrl).toString());
      return;
    }
    const packagedPath = path.join(process.resourcesPath, "app-dist", OVERLAY_HTML);
    const devPath = path.resolve(__dirname, "../../../app/dist", OVERLAY_HTML);
    await window.loadFile(app.isPackaged ? packagedPath : devPath);
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
