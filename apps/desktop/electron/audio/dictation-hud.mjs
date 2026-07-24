import { BrowserWindow, screen } from "electron";

const SIZE = 24;

export class DictationHud {
  constructor() {
    /** @type {BrowserWindow | null} */
    this.window = null;
    this.hideTimer = null;
    this.updateVersion = 0;
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const area = screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      x: Math.round(area.x + (area.width - SIZE) / 2),
      y: area.y + area.height - SIZE - 18,
      // A non-activating NSPanel: the HUD must never take key status from
      // the app that is about to receive the paste.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The pulse animation runs while every app window is unfocused —
        // exactly when Chromium would throttle it.
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    // skipTransformProcessType: without it this call can flip the process
    // activation policy and dismiss the dock icon (electron#26350).
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{width:100%;height:100%;margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
body{display:flex;align-items:center;justify-content:center}
main{width:18px;height:18px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.18);border-radius:50%;background:rgba(20,20,22,.9);box-shadow:0 3px 10px rgba(0,0,0,.25)}
#dot{width:6px;height:6px;border-radius:50%;background:#36a269}
#dot.listening{animation:pulse 1.15s ease-in-out infinite}#dot.transcribing{background:#d49b31}#dot.error{background:#df5b55}
@keyframes pulse{50%{opacity:.42}}
</style></head><body><main><span id="dot"></span></main></body></html>`)}`);
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    this.window = window;
    return window;
  }

  async setState(state, _message = "") {
    const updateVersion = ++this.updateVersion;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (state === "idle") {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      return;
    }
    const window = await this.ensureWindow();
    if (updateVersion !== this.updateVersion || window.isDestroyed()) return;
    await window.webContents.executeJavaScript(
      `document.getElementById("dot").className=${JSON.stringify(state)};`,
    );
    if (updateVersion !== this.updateVersion || window.isDestroyed()) return;
    window.showInactive();
    if (state === "error") {
      this.hideTimer = setTimeout(() => {
        if (updateVersion === this.updateVersion && !window.isDestroyed()) window.hide();
      }, 5_000);
    }
  }

  destroy() {
    this.updateVersion += 1;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
