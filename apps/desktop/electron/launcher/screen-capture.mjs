import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, systemPreferences } from "electron";
import { windowCaptureSource } from "./capture-source.mjs";

const OVERLAY_CHANNEL = "legalwork:launcher:region";

function permissionDenied() {
  if (process.platform !== "darwin") return false;
  try { return systemPreferences.getMediaAccessStatus("screen") === "denied"; } catch { return false; }
}
function dataUrl(image) { return image.toPNG().toString("base64") ? `data:image/png;base64,${image.toPNG().toString("base64")}` : ""; }

/**
 * Explicit, one-shot captures. Nothing watches the screen; the panel is hidden
 * before the capture so it never appears in its own screenshot, and a denied
 * permission or a cancelled region leaves the draft untouched.
 */
export class ScreenCapture {
  /** @param {{ hiddenWhile: <T>(work: () => Promise<T>) => Promise<T>, origin: () => { app?: string | null, window?: string | null } | null }} options */
  constructor(options) { this.options = options; /** @type {BrowserWindow | null} */ this.overlay = null; }
  /** @returns {Promise<import("@legalwork/types/launcher").LauncherCaptureResult>} */
  async captureWindow() {
    if (permissionDenied()) return { ok: false, reason: "denied", message: "Screen recording permission is needed to capture a window." };
    return this.options.hiddenWhile(async () => {
      try {
        const origin = this.options.origin();
        const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false });
        const match = windowCaptureSource(sources, origin);
        if (!match || match.thumbnail.isEmpty()) return { ok: false, reason: "failed", message: "No window could be captured." };
        return { ok: true, capture: { dataUrl: dataUrl(match.thumbnail), width: match.thumbnail.getSize().width, height: match.thumbnail.getSize().height, capture: "window", sourceApp: origin?.app ?? null, sourceWindow: match.name, capturedAt: Date.now() } };
      } catch (error) { return { ok: false, reason: permissionDenied() ? "denied" : "failed", message: error instanceof Error ? error.message : String(error) }; }
    });
  }
  /**
   * A full-display screenshot behind a transparent overlay; the user drags a rectangle or presses Escape.
   * @returns {Promise<import("@legalwork/types/launcher").LauncherCaptureResult>}
   */
  async captureRegion() {
    if (permissionDenied()) return { ok: false, reason: "denied", message: "Screen recording permission is needed to capture a region." };
    return this.options.hiddenWhile(async () => {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const scale = display.scaleFactor || 1;
      let shot;
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
        shot = sources.find(source => source.display_id === String(display.id)) ?? sources[0];
      } catch (error) { return { ok: false, reason: permissionDenied() ? "denied" : "failed", message: error instanceof Error ? error.message : String(error) }; }
      if (!shot || shot.thumbnail.isEmpty()) return { ok: false, reason: "failed", message: "The screen could not be captured." };
      const rect = await this.selectRegion(display);
      if (!rect) return { ok: false, reason: "cancelled", message: "" };
      const crop = shot.thumbnail.crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) });
      const origin = this.options.origin();
      return { ok: true, capture: { dataUrl: dataUrl(crop), width: crop.getSize().width, height: crop.getSize().height, capture: "region", sourceApp: origin?.app ?? null, sourceWindow: origin?.window ?? null, capturedAt: Date.now() } };
    });
  }
  /** @param {import("electron").Display} display @returns {Promise<{ x: number, y: number, width: number, height: number } | null>} */
  selectRegion(display) {
    return new Promise(resolve => {
      const overlay = new BrowserWindow({ ...display.bounds, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false, show: false, enableLargerThanScreen: true,
        webPreferences: { preload: fileURLToPath(new URL("./region-overlay-preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      this.overlay = overlay;
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      const finish = result => { ipcMain.removeListener(OVERLAY_CHANNEL, onMessage); if (!overlay.isDestroyed()) overlay.destroy(); this.overlay = null; resolve(result); };
      const onMessage = (event, payload) => {
        if (event.sender !== overlay.webContents) return;
        if (!payload || payload.type === "cancel") finish(null);
        else if (payload.type === "select" && payload.width >= 4 && payload.height >= 4) finish({ x: payload.x, y: payload.y, width: payload.width, height: payload.height });
      };
      ipcMain.on(OVERLAY_CHANNEL, onMessage);
      overlay.on("closed", () => finish(null));
      overlay.on("blur", () => { if (!overlay.isDestroyed()) overlay.focus(); });
      void overlay.loadFile(fileURLToPath(new URL("./region-overlay.html", import.meta.url))).then(() => { overlay.show(); overlay.focus(); }).catch(() => finish(null));
    });
  }
  destroy() { if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy(); this.overlay = null; }
}
export const OVERLAY_IPC_CHANNEL = OVERLAY_CHANNEL;
export { nativeImage as _nativeImage, path as _path };
