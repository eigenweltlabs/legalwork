import { BrowserWindow, screen } from "electron";

const WIDTH = 260;
const HEIGHT = 58;

const LABELS = {
  listening: "Listening - press shortcut to finish",
  transcribing: "Transcribing on this device",
  error: "Dictation needs attention",
};

export class DictationHud {
  constructor() {
    /** @type {BrowserWindow | null} */
    this.window = null;
    this.hideTimer = null;
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const area = screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: area.y + area.height - HEIGHT - 32,
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
      hasShadow: true,
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
main{width:calc(100% - 12px);height:46px;box-sizing:border-box;display:flex;align-items:center;gap:11px;padding:0 14px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(20,20,22,.94);color:#f4f4f5;box-shadow:0 8px 28px rgba(0,0,0,.32)}
#dot{width:10px;height:10px;flex:none;border-radius:50%;background:#36a269;box-shadow:0 0 0 4px rgba(54,162,105,.16)}
#dot.listening{animation:pulse 1.15s ease-in-out infinite}#dot.transcribing{background:#d49b31;box-shadow:0 0 0 4px rgba(212,155,49,.16)}#dot.error{background:#df5b55;box-shadow:0 0 0 4px rgba(223,91,85,.16)}
#label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
@keyframes pulse{50%{opacity:.42}}
</style></head><body><main><span id="dot"></span><span id="label"></span></main></body></html>`)}`);
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    this.window = window;
    return window;
  }

  async setState(state, message = "") {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (state === "idle") {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      return;
    }
    const window = await this.ensureWindow();
    const label = message.trim() || LABELS[state] || "System-wide dictation";
    await window.webContents.executeJavaScript(
      `document.getElementById("dot").className=${JSON.stringify(state)};document.getElementById("label").textContent=${JSON.stringify(label)};`,
    );
    window.showInactive();
    if (state === "error") {
      this.hideTimer = setTimeout(() => {
        if (!window.isDestroyed()) window.hide();
      }, 5_000);
    }
  }

  destroy() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
