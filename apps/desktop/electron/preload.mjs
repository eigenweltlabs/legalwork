import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "legalwork:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "legalwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "legalwork:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "legalwork:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "legalwork:native-menu:zoom";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.legalworkShell = "electron";
    root.classList.add("legalwork-electron");
    if (process.platform === "darwin") {
      root.classList.add("legalwork-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("legalwork-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("legalwork-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("legalwork:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld("__LEGALWORK_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("legalwork:desktop", command, ...args);
  },
  /** Subscribe to content-free error signals relayed from the main process. */
  onAppError(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("legalwork:app-error", handler);
    return () => {
      ipcRenderer.removeListener("legalwork:app-error", handler);
    };
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("legalwork:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("legalwork:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("legalwork:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("legalwork:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("legalwork:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("legalwork:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("legalwork:migration:ack");
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("legalwork:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("legalwork:updater:setChannel", channel);
    },
    check(channel) {
      return ipcRenderer.invoke("legalwork:updater:check", channel);
    },
    download() {
      return ipcRenderer.invoke("legalwork:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("legalwork:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("legalwork:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("legalwork:updater:download-progress", handler);
      };
    },
  },
  browser: {
    show(bounds) { return ipcRenderer.invoke("legalwork:browser:show", bounds); },
    hide() { return ipcRenderer.invoke("legalwork:browser:hide"); },
    openUrl(url, provider) { return ipcRenderer.invoke("legalwork:browser:openUrl", url, provider); },
    navigate(url) { return ipcRenderer.invoke("legalwork:browser:navigate", url); },
    back() { return ipcRenderer.invoke("legalwork:browser:back"); },
    forward() { return ipcRenderer.invoke("legalwork:browser:forward"); },
    reload() { return ipcRenderer.invoke("legalwork:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("legalwork:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("legalwork:browser:state"); },
    createTab(url) { return ipcRenderer.invoke("legalwork:browser:createTab", url); },
    closeTab(tabId) { return ipcRenderer.invoke("legalwork:browser:closeTab", tabId); },
    closeAllTabs() { return ipcRenderer.invoke("legalwork:browser:closeAllTabs"); },
    selectTab(tabId) { return ipcRenderer.invoke("legalwork:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("legalwork:browser:reorderTabs", tabIds); },
    listTabs() { return ipcRenderer.invoke("legalwork:browser:listTabs"); },
    setProxy(proxy) { return ipcRenderer.invoke("legalwork:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("legalwork:browser:getProxy"); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("legalwork:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("legalwork:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("legalwork:browser:state", handler);
      return () => ipcRenderer.removeListener("legalwork:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = () => callback();
      ipcRenderer.on("legalwork:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("legalwork:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = () => callback();
      ipcRenderer.on("legalwork:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("legalwork:browser:panel-closed", handler);
    },
  },
  audio: {
    /** Stream 16 kHz mono Float32 PCM to the local transcriber (fire-and-forget). */
    sendPcm(streamId, buffer) {
      ipcRenderer.send("legalwork:audio:pcm", streamId, buffer);
    },
    /** Append a MediaRecorder chunk to the recording file on disk. */
    sendMediaChunk(recordingId, chunk) {
      ipcRenderer.send("legalwork:audio:media-chunk", recordingId, chunk);
    },
    /** Stream an AI answer back to the call overlay. */
    sendAskAnswer(askId, text, done, error) {
      ipcRenderer.send("legalwork:audio:ask-answer", askId, text, done, error ?? null);
    },
    /** Subscribe to recorder events (transcript, model downloads, overlay asks). */
    onEvent(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("legalwork:audio:event", handler);
      return () => {
        ipcRenderer.removeListener("legalwork:audio:event", handler);
      };
    },
    /** PCM from the native per-app audio tap (macOS), mixed by the renderer. */
    onAppPcm(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("legalwork:audio:app-pcm", handler);
      return () => {
        ipcRenderer.removeListener("legalwork:audio:app-pcm", handler);
      };
    },
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("legalwork:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("legalwork:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("legalwork:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("legalwork:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("legalwork:terminal:data", handler);
      return () => ipcRenderer.removeListener("legalwork:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("legalwork:terminal:exit", handler);
      return () => ipcRenderer.removeListener("legalwork:terminal:exit", handler);
    },
  },
  meta: {
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
  },
});

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
