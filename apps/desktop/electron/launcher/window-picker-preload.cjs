const { contextBridge, ipcRenderer } = require("electron");

const channel = "legalwork:launcher:window-picker";
contextBridge.exposeInMainWorld("capturePicker", {
  onSources: callback => ipcRenderer.once(channel, (_event, sources) => callback(sources)),
  select: id => ipcRenderer.send(channel, typeof id === "string" ? id : null),
});
