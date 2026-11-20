const { contextBridge, ipcRenderer } = require("electron");
const channel = "legalwork:launcher:region";
contextBridge.exposeInMainWorld("regionOverlay", {
  measure: rect => ipcRenderer.send(channel, { ...rect, type: "measure" }),
  onSize: callback => ipcRenderer.on(channel, (_event, size) => callback(size)),
  select: rect => ipcRenderer.send(channel, { ...rect, type: "select" }),
  cancel: () => ipcRenderer.send(channel, { type: "cancel" }),
});
