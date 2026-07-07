import { contextBridge, ipcRenderer } from "electron";

const AUDIO_EVENT_CHANNEL = "legalwork:audio:event";

/**
 * Bridge for the call overlay window: receive the recorder event feed
 * (live transcript, transcriber status, AI answers) and send interactions
 * (typed questions, follow-up suggestion requests, hide) back to main.
 */
contextBridge.exposeInMainWorld("__LEGALWORK_CALL_OVERLAY__", {
  onEvent(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(AUDIO_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(AUDIO_EVENT_CHANNEL, handler);
  },
  ask(askId, question) {
    ipcRenderer.send("legalwork:audio:overlay-ask", askId, question);
  },
  suggest(askId) {
    ipcRenderer.send("legalwork:audio:overlay-suggest", askId);
  },
  hide() {
    ipcRenderer.send("legalwork:audio:overlay-hide");
  },
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
});
