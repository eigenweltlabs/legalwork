import { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen } from "electron";
import { fileURLToPath } from "node:url";

const WIDTH = 440;
const HEIGHT = 220;
const BOTTOM_GAP = 4;
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
    /** @type {Pick<import("@legalwork/types/audio").AudioSystemDictationStatus, "enabled" | "registered" | "shortcutCaptureActive" | "mode" | "accelerator" | "platform">} */
    this.status = { enabled: false, registered: false, shortcutCaptureActive: false, mode: "tap", accelerator: "", platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux" };
    this.hideTimer = null;
    this.updateVersion = 0;
    this.onAction = (event, action) => {
      if (!this.window || event.sender !== this.window.webContents) return;
      if (action === "ready") this.sendState();
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
      this.window.setIgnoreMouseEvents(!interactive, { forward: true });
    };
    this.onTheme = () => this.sendState();
    ipcMain.on(`${CHANNEL}:action`, this.onAction);
    ipcMain.on(`${CHANNEL}:pointer`, this.onPointer);
    nativeTheme.on("updated", this.onTheme);
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
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: area.y + area.height - HEIGHT - BOTTOM_GAP,
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

  sendState() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(`${CHANNEL}:state`, {
      state: this.displayState,
      meeting: this.meeting,
      message: this.message,
      microphoneName: this.microphoneName,
      locale: this.locale || (app.getLocale().startsWith("de") ? "de" : "en"),
      ...this.status,
      dark: nativeTheme.shouldUseDarkColors,
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
    if (this.state === "idle") await this.setState("idle");
    else this.sendState();
  }

  async setState(state, message = "", locale = this.locale) {
    const version = ++this.updateVersion;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    const previous = this.state;
    this.state = state;
    this.message = message;
    this.locale = locale;
    const resting = state === "idle";
    const meetingVisible = this.meeting && (this.meeting.detectionEnabled || this.meeting.state !== "idle");
    if (resting && !meetingVisible && (!this.status.enabled || !this.status.registered || this.status.shortcutCaptureActive)) {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      return;
    }
    const window = await this.ensureWindow();
    if (version !== this.updateVersion || window.isDestroyed()) return;
    if (state === "starting" && ["idle", "success", "cancelled", "error"].includes(previous)) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      window.setPosition(Math.round(area.x + (area.width - WIDTH) / 2), area.y + area.height - HEIGHT - BOTTOM_GAP);
    }
    this.sendState();
    window.showInactive();
    const settleMs = state === "idle" && message ? 2_000 : state === "error" ? 8_000 : ["success", "cancelled"].includes(state) ? 1_200 : 0;
    if (settleMs) this.hideTimer = setTimeout(() => {
      if (version === this.updateVersion) void this.setState("idle");
    }, settleMs);
  }

  /** @param {number} level */
  feedLevel(level) {
    if (!["starting", "listening", "meeting-starting", "meeting-recording"].includes(this.displayState) || !this.window || this.window.isDestroyed()) return;
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) return;
    this.window.webContents.send(`${CHANNEL}:level`, level);
  }

  destroy() {
    this.updateVersion += 1;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    ipcMain.removeListener(`${CHANNEL}:action`, this.onAction);
    ipcMain.removeListener(`${CHANNEL}:pointer`, this.onPointer);
    nativeTheme.removeListener("updated", this.onTheme);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
