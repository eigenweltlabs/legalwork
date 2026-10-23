import { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen } from "electron";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dockBounds, DOCKS, nearestDock } from "./dictation-dock.mjs";
import { watchFocusedDisplay } from "./focused-display.mjs";

const CHANNEL = "legalwork:dictation-hud";

/** A non-activating control bar: clicking it must preserve the paste target. */
export class DictationHud {
  /** @param {{ onStart: () => void, onStop: () => void, onCancel: () => void, onMicrophoneMenu?: () => void, onMeetingStart?: () => void, onMeetingStop?: () => void, onMeetingDismiss?: () => void, onMeetingOpen?: () => void }} actions */
  constructor(actions) {
    this.actions = actions;
    /** @type {BrowserWindow | null} */
    this.window = null;
    /** @type {Promise<BrowserWindow> | null} */
    this.windowPromise = null;
    this.state = "idle";
    this.message = "";
    this.microphoneName = "";
    /** @type {import('@legalwork/types/audio').AudioMeetingStatus | null} */
    this.meeting = null;
    /** @type {"en" | "de" | null} */
    this.locale = null;
    /** @type {Pick<import("@legalwork/types/audio").AudioSystemDictationStatus, "miniBarEnabled" | "enabled" | "registered" | "shortcutCaptureActive" | "mode" | "accelerator" | "platform" | "appearance">} */
    this.status = { miniBarEnabled: false, appearance: "app", enabled: false, registered: false, shortcutCaptureActive: false, mode: "tap", accelerator: "", platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux" };
    this.hideTimer = null;
    this.settleKey = "";
    this.updateVersion = 0;
    this.dock = "bottom";
    this.displayId = null;
    this.focusedDisplayId = null;
    this.stopWatchingDisplay = null;
    this.drag = null;
    this.dragTimer = null;
    this.cursorTimer = null;
    /** @type {BrowserWindow | null} */
    this.dockPreview = null;
    this.positionPath = path.join(app.getPath("userData"), "dictation-hud-position.json");
    this.positionLoaded = null;
    this.displayEventsRegistered = false;
    this.positionWrites = Promise.resolve();
    this.onDrag = (event, phase, anchor) => {
      if (!this.window || event.sender !== this.window.webContents) return;
      if (phase === "start") this.beginDrag(anchor);
      else if (phase === "move") this.moveDrag();
      else if (phase === "end" || phase === "cancel") this.endDrag(phase === "end");
    };
    this.onDisplayChange = () => {
      if (!this.drag && this.window && !this.window.isDestroyed()) { this.followDisplay(); this.positionWindow(); }
    };
    this.onAction = (event, action) => {
      if (!this.window || event.sender !== this.window.webContents) return;
      if (action === "ready") this.sendState();
      if (!this.status.miniBarEnabled) return;
      if (action === "meeting-start" && ["idle", "meeting-error"].includes(this.displayState)) this.actions.onMeetingStart?.();
      if (action === "meeting-stop" && this.displayState === "meeting-recording") this.actions.onMeetingStop?.();
      if (action === "meeting-dismiss") this.actions.onMeetingDismiss?.();
      if (action === "meeting-open") this.actions.onMeetingOpen?.();
      if (this.meeting && this.meeting.state !== "idle") return;
      if (action === "microphone-menu" && this.state === "idle") this.actions.onMicrophoneMenu?.();
      if (action === "start" && this.state === "idle" && this.status.enabled && this.status.registered) this.actions.onStart();
      if (action === "stop" && this.state === "listening") this.actions.onStop();
      if (action === "stop" && this.state === "starting") this.actions.onCancel();
      if (action === "cancel" && ["starting", "listening", "transcribing"].includes(this.state)) this.actions.onCancel();
      if (action === "dismiss" && ["error", "success", "cancelled"].includes(this.state)) void this.setState("idle");
    };
    this.onPointer = (event, interactive) => {
      if (!this.window || event.sender !== this.window.webContents || typeof interactive !== "boolean") return;
      if (this.drag) return;
      this.window.setIgnoreMouseEvents(!interactive, { forward: true });
    };
    this.onTheme = () => this.sendState();
    ipcMain.on(`${CHANNEL}:action`, this.onAction);
    ipcMain.on(`${CHANNEL}:pointer`, this.onPointer);
    ipcMain.on(`${CHANNEL}:drag`, this.onDrag);
    nativeTheme.on("updated", this.onTheme);
  }

  get dark() {
    return this.status.appearance === "black" || (this.status.appearance !== "white" && nativeTheme.shouldUseDarkColors);
  }

  get displayState() {
    return this.meeting && this.meeting.state !== "idle" ? `meeting-${this.meeting.state}` : this.state;
  }

  /** @param {import('@legalwork/types/audio').AudioMeetingStatus} status */
  async setMeeting(status) {
    this.meeting = status;
    await this.setState(this.state, this.message, this.locale);
  }

  async ensureWindow() {
    if (this.windowPromise) return this.windowPromise;
    if (this.window && !this.window.isDestroyed()) return this.window;
    if (!this.displayEventsRegistered) {
      screen.on("display-metrics-changed", this.onDisplayChange);
      screen.on("display-removed", this.onDisplayChange);
      screen.on("display-added", this.onDisplayChange);
      this.displayEventsRegistered = true;
    }
    if (!this.positionLoaded) this.positionLoaded = readFile(this.positionPath, "utf8").then(raw => {
      const saved = JSON.parse(raw);
      if (DOCKS.includes(saved.dock)) this.dock = saved.dock;
      if (Number.isInteger(saved.displayId)) this.displayId = saved.displayId;
    }).catch(() => {});
    await this.positionLoaded;
    // Another state update may have created the window while the position loaded.
    if (this.windowPromise) return this.windowPromise;
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = this.display();
    this.displayId = display.id;
    const window = new BrowserWindow({
      ...dockBounds(display.workArea, this.dock),
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
        preload: fileURLToPath(new URL("./dictation-hud-preload.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.window = window;
    this.stopWatchingDisplay = watchFocusedDisplay(id => {
      this.focusedDisplayId = id;
      this.followDisplay();
    });
    // Native windows can move without Chromium receiving a mouseleave event.
    this.cursorTimer = setInterval(() => {
      if (!window.isDestroyed() && window.isVisible() && !this.drag) {
        if (!screen.getAllDisplays().some(display => display.id === this.focusedDisplayId)) this.followDisplay();
        this.sendCursor();
      }
    }, 50);
    window.on("closed", () => {
      clearInterval(this.cursorTimer); clearInterval(this.dragTimer);
      this.stopWatchingDisplay?.(); this.stopWatchingDisplay = null;
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    this.windowPromise = window.loadFile(fileURLToPath(new URL("./dictation-hud.html", import.meta.url)))
      .then(() => window).finally(() => { this.windowPromise = null; });
    return this.windowPromise;
  }

  display() {
    return screen.getAllDisplays().find(display => display.id === this.displayId) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  followDisplay() {
    if (this.drag || !this.window || this.window.isDestroyed()) return;
    const display = screen.getAllDisplays().find(display => display.id === this.focusedDisplayId)
      ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (display.id === this.displayId) return;
    this.displayId = display.id;
    this.positionWindow();
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.sendCursor(true);
  }

  positionWindow() {
    const display = this.display();
    this.displayId = display.id;
    this.window?.setBounds(dockBounds(display.workArea, this.dock));
    this.sendState();
  }

  sendCursor(reset = false) {
    if (!this.window || this.window.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const bounds = this.window.getBounds();
    this.window.webContents.send(`${CHANNEL}:cursor`, { x: point.x - bounds.x, y: point.y - bounds.y, reset });
  }

  beginDrag(anchor) {
    if (!this.window || this.drag) return;
    const point = screen.getCursorScreenPoint();
    const bounds = this.window.getBounds();
    this.drag = { offsetX: point.x - bounds.x, offsetY: point.y - bounds.y, dock: this.dock, displayId: this.displayId };
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      && anchor.x >= 0 && anchor.x <= bounds.width && anchor.y >= 0 && anchor.y <= bounds.height) {
      this.drag.offsetX = anchor.x;
      this.drag.offsetY = anchor.y;
    }
    this.dragTimer = setInterval(() => this.moveDrag(), 16);
    this.window.setIgnoreMouseEvents(false);
    this.moveDrag();
    this.dockPreview = new BrowserWindow({
      ...screen.getDisplayNearestPoint(point).workArea,
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, resizable: false, show: false,
      webPreferences: {
        preload: fileURLToPath(new URL("./dictation-hud-preload.cjs", import.meta.url)),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    const preview = this.dockPreview;
    preview.setAlwaysOnTop(true, "pop-up-menu");
    preview.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    preview.setIgnoreMouseEvents(true);
    preview.setContentProtection(true);
    preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    preview.webContents.on("will-navigate", event => event.preventDefault());
    void preview.loadFile(fileURLToPath(new URL("./dictation-hud.html", import.meta.url)), { query: { preview: "1" } }).then(() => {
      if (preview.isDestroyed() || !this.drag) return;
      this.moveDrag();
      preview.showInactive();
    }).catch(() => { if (this.dockPreview === preview) this.endDrag(false); });
  }

  moveDrag() {
    if (!this.drag || !this.window) return;
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    this.window.setPosition(Math.round(point.x - this.drag.offsetX), Math.round(point.y - this.drag.offsetY));
    if (this.dockPreview && !this.dockPreview.isDestroyed()) {
      this.dockPreview.setBounds(display.workArea);
      this.dockPreview.webContents.send(`${CHANNEL}:state`, { preview: true, dock: nearestDock(display.workArea, point), appearance: this.status.appearance, dark: this.dark });
    }
  }

  endDrag(save) {
    if (!this.drag) return;
    if (save) {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      this.displayId = display.id;
      this.dock = nearestDock(display.workArea, point);
      const saved = JSON.stringify({ dock: this.dock, displayId: this.displayId });
      this.positionWrites = this.positionWrites.catch(() => {}).then(() => writeFile(this.positionPath, saved));
      void this.positionWrites.catch(error => console.warn("[dictation-hud] Could not save position", error));
    }
    this.drag = null;
    clearInterval(this.dragTimer);
    this.dragTimer = null;
    this.dockPreview?.destroy();
    this.dockPreview = null;
    this.positionWindow();
    this.window?.setIgnoreMouseEvents(true, { forward: true });
    this.sendCursor(true);
  }

  sendState() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(`${CHANNEL}:state`, {
      state: this.displayState,
      meeting: this.meeting,
      message: this.message,
      microphoneName: this.microphoneName,
      dock: this.dock,
      locale: this.locale || (app.getLocale().startsWith("de") ? "de" : "en"),
      ...this.status,
      dark: this.dark,
    });
  }

  /** @param {string | null} name */
  setMicrophone(name) {
    this.microphoneName = name ?? "";
    this.sendState();
  }

  /** @param {import('@legalwork/types/audio').AudioDictationMicrophoneState} state @param {(selection: string) => void} select */
  microphoneMenu(state, select) {
    const german = (this.locale || app.getLocale()).startsWith("de");
    const unavailable = german ? "Nicht verfügbar" : "Unavailable";
    /** @type {import('electron').MenuItemConstructorOptions[]} */
    const items = [
      { label: german ? "Mikrofon" : "Microphone", enabled: false },
      { type: "separator" },
      { label: german ? "Automatisch (empfohlen)" : "Automatic (recommended)", type: "radio", checked: state.selection === "auto", click: () => select("auto") },
      { label: german ? "Systemstandard" : "System default", type: "radio", checked: state.selection === "default", click: () => select("default") },
      ...state.devices.map(/** @returns {import('electron').MenuItemConstructorOptions} */ device => ({
        label: device.name + (device.available ? "" : ` (${unavailable})`),
        type: "radio", checked: state.selection === device.id, enabled: device.available,
        click: () => select(device.id),
      })),
    ];
    if (!["auto", "default"].includes(state.selection) && !state.devices.some(device => device.id === state.selection)) {
      items.push({ label: `${state.selectedName} (${unavailable})`, type: "radio", checked: true, enabled: false });
    }
    const name = state.activeName || state.devices.find(device => device.id === state.resolvedDeviceId)?.name;
    if (name) items.push({ type: "separator" }, { label: `${german ? "Mikrofon" : "Microphone"}: ${name}`, enabled: false });
    return Menu.buildFromTemplate(items);
  }

  /** @param {import('@legalwork/types/audio').AudioDictationMicrophoneState} state @param {(selection: string) => void} select */
  showMicrophoneMenu(state, select) {
    if (!this.window || this.state !== "idle") return;
    this.microphoneMenu(state, select).popup({ window: this.window });
  }

  /** @param {import("@legalwork/types/audio").AudioSystemDictationStatus} status */
  async setStatus(status) {
    this.status = status;
    await this.setState(this.state, this.message);
  }

  async setState(state, message = "", locale = this.locale) {
    const version = ++this.updateVersion;
    this.state = state;
    this.message = message;
    this.locale = locale;
    const displayed = this.displayState;
    const settleMs = ["error", "meeting-error"].includes(displayed) ? 4_000
      : displayed === "idle" && message ? 2_000
      : ["success", "cancelled"].includes(displayed) ? 1_200 : 0;
    const settleKey = settleMs ? JSON.stringify([displayed, message, this.meeting?.error]) : "";
    // Status refreshes must not keep a transient notice alive indefinitely.
    if (settleKey !== this.settleKey) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
      this.settleKey = settleKey;
      if (settleMs) this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (this.displayState === "meeting-error") this.actions.onMeetingDismiss?.();
        else void this.setState("idle");
      }, settleMs);
    }
    const resting = state === "idle";
    const meetingVisible = this.meeting && (this.meeting.detectionEnabled || this.meeting.state !== "idle");
    if (!this.status.miniBarEnabled || (resting && !meetingVisible && this.status.shortcutCaptureActive)) {
      if (this.drag) this.endDrag(false);
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      return;
    }
    const window = await this.ensureWindow();
    if (version !== this.updateVersion || window.isDestroyed()) return;
    this.sendState();
    window.showInactive();
  }

  /** @param {number} level */
  feedLevel(level) {
    if (!["starting", "listening", "meeting-starting", "meeting-recording"].includes(this.displayState) || !this.window || this.window.isDestroyed()) return;
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) return;
    this.window.webContents.send(`${CHANNEL}:level`, level);
  }

  destroy() {
    this.updateVersion += 1;
    clearInterval(this.cursorTimer);
    clearInterval(this.dragTimer);
    this.stopWatchingDisplay?.();
    this.stopWatchingDisplay = null;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    ipcMain.removeListener(`${CHANNEL}:action`, this.onAction);
    ipcMain.removeListener(`${CHANNEL}:pointer`, this.onPointer);
    ipcMain.removeListener(`${CHANNEL}:drag`, this.onDrag);
    nativeTheme.removeListener("updated", this.onTheme);
    if (this.displayEventsRegistered) {
      screen.removeListener("display-metrics-changed", this.onDisplayChange);
      screen.removeListener("display-removed", this.onDisplayChange);
      screen.removeListener("display-added", this.onDisplayChange);
    }
    this.dockPreview?.destroy();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
