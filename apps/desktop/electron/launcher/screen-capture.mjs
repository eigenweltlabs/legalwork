import { fileURLToPath } from "node:url";
import { BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } from "electron";
import { displayCaptureSource, capturePixelRect } from "./capture-geometry.mjs";

const OVERLAY_CHANNEL = "legalwork:launcher:region";
const PICKER_CHANNEL = "legalwork:launcher:window-picker";

function permissionDenied() {
  if (process.platform !== "darwin") return false;
  try { return systemPreferences.getMediaAccessStatus("screen") === "denied"; } catch { return false; }
}
function dataUrl(image) { return image.toDataURL(); }

/**
 * Explicit, one-shot captures. Nothing watches the screen; the panel is hidden
 * before the capture so it never appears in its own screenshot, and a denied
 * permission or a cancelled region leaves the draft untouched.
 */
export class ScreenCapture {
  /** @param {{ hiddenWhile: <T>(work: () => Promise<T>) => Promise<T> }} options */
  constructor(options) { this.options = options; /** @type {BrowserWindow | null} */ this.overlay = null; }
  /** @returns {Promise<import("@legalwork/types/launcher").LauncherCaptureResult>} */
  async captureWindow() {
    if (permissionDenied()) return { ok: false, reason: "denied", message: "Screen recording permission is needed to capture a window." };
    return this.options.hiddenWhile(async () => {
      try {
        const available = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false });
        const sources = available.filter(source => !source.thumbnail.isEmpty());
        if (!sources.length) return { ok: false, reason: permissionDenied() ? "denied" : "failed", message: "No capturable windows are available." };
        const selected = await this.chooseWindow(sources);
        if (!selected) return { ok: false, reason: "cancelled", message: "" };
        return { ok: true, capture: { dataUrl: dataUrl(selected.thumbnail), ...selected.thumbnail.getSize(), capture: "window", sourceApp: null, sourceWindow: selected.name.slice(0, 400), capturedAt: Date.now() } };
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
        shot = displayCaptureSource(sources, display.id, screen.getAllDisplays().length);
      } catch (error) { return { ok: false, reason: permissionDenied() ? "denied" : "failed", message: error instanceof Error ? error.message : String(error) }; }
      if (!shot || shot.thumbnail.isEmpty()) return { ok: false, reason: permissionDenied() ? "denied" : "failed", message: "The selected display could not be matched to a capture source." };
      try {
        const pixels = await this.selectRegion(display, shot.thumbnail.getSize());
        if (!pixels) return { ok: false, reason: "cancelled", message: "" };
        const crop = shot.thumbnail.crop(pixels);
        return { ok: true, capture: { dataUrl: dataUrl(crop), ...crop.getSize(), capture: "region", sourceApp: null, sourceWindow: null, capturedAt: Date.now() } };
      } catch (error) { return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) }; }
    });
  }
  /** @param {import("electron").DesktopCapturerSource[]} sources */
  chooseWindow(sources) {
    return new Promise((resolve, reject) => {
      const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const width = Math.min(workArea.width, 620), height = Math.min(workArea.height, 540);
      const picker = new BrowserWindow({
        x: workArea.x + Math.floor((workArea.width - width) / 2), y: workArea.y + Math.floor((workArea.height - height) / 2),
        width, height, show: false, title: "Capture Window", alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { preload: fileURLToPath(new URL("./window-picker-preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      this.overlay = picker;
      picker.setMenuBarVisibility(false);
      let finished = false;
      const finish = (selected, error = null) => {
        if (finished) return;
        finished = true;
        ipcMain.removeListener(PICKER_CHANNEL, onSelect);
        if (this.overlay === picker) this.overlay = null;
        if (error) reject(error);
        else resolve(selected);
        if (!picker.isDestroyed()) picker.destroy();
      };
      const onSelect = (event, id) => {
        if (event.sender === picker.webContents) finish(sources.find(source => source.id === id) ?? null);
      };
      ipcMain.on(PICKER_CHANNEL, onSelect);
      picker.once("closed", () => finish(null));
      void picker.loadFile(fileURLToPath(new URL("./window-picker.html", import.meta.url))).then(() => {
        if (picker.isDestroyed()) return;
        picker.webContents.send(PICKER_CHANNEL, sources.map(source => ({
          id: source.id, name: source.name, dataUrl: source.thumbnail.resize({ width: 280 }).toDataURL(),
        })));
        picker.show();
      }).catch(error => finish(null, error));
    });
  }
  /** @param {import("electron").Display} display @param {import("electron").Size} imageSize @returns {Promise<{ x: number, y: number, width: number, height: number } | null>} */
  selectRegion(display, imageSize) {
    return new Promise((resolve, reject) => {
      const overlay = new BrowserWindow({ ...display.bounds, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false, show: false, enableLargerThanScreen: true,
        webPreferences: { preload: fileURLToPath(new URL("./region-overlay-preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      this.overlay = overlay;
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      let finished = false;
      const finish = (result, error = null) => {
        if (finished) return;
        finished = true;
        ipcMain.removeListener(OVERLAY_CHANNEL, onMessage);
        this.overlay = null;
        if (error) reject(error);
        else resolve(result);
        if (!overlay.isDestroyed()) overlay.destroy();
      };
      const onMessage = (event, payload) => {
        if (event.sender !== overlay.webContents) return;
        if (!payload || payload.type === "cancel") finish(null);
        else if (payload.type === "measure" || payload.type === "select") {
          if (![payload.x, payload.y, payload.width, payload.height].every(Number.isFinite)) return;
          const bounds = overlay.getContentBounds();
          if (screen.getDisplayMatching(bounds).id !== display.id) {
            finish(null, new Error("The display changed during capture. Open the capture again."));
            return;
          }
          const pixels = capturePixelRect({ x: payload.x + bounds.x - display.bounds.x,
            y: payload.y + bounds.y - display.bounds.y, width: payload.width, height: payload.height }, display.bounds, imageSize);
          if (payload.type === "measure") event.sender.send(OVERLAY_CHANNEL, { width: pixels?.width ?? 0, height: pixels?.height ?? 0 });
          else if (payload.width >= 4 && payload.height >= 4) {
            if (pixels) finish(pixels);
            else finish(null, new Error("The selected region is outside the captured display."));
          }
        }
      };
      ipcMain.on(OVERLAY_CHANNEL, onMessage);
      overlay.on("closed", () => finish(null));
      overlay.on("blur", () => { if (!overlay.isDestroyed()) overlay.focus(); });
      void overlay.loadFile(fileURLToPath(new URL("./region-overlay.html", import.meta.url))).then(() => { if (!overlay.isDestroyed()) { overlay.show(); overlay.focus(); } }).catch(error => finish(null, error));
    });
  }
  destroy() { if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy(); this.overlay = null; }
}
export const OVERLAY_IPC_CHANNEL = OVERLAY_CHANNEL;
