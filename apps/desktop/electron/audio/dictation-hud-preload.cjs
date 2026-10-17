const { contextBridge, ipcRenderer } = require("electron");
const channel = "legalwork:dictation-hud";

contextBridge.exposeInMainWorld("dictationHud", {
  action: (action) => ipcRenderer.send(`${channel}:action`, action),
  pointer: (interactive) => ipcRenderer.send(`${channel}:pointer`, interactive),
  onState: (callback) => ipcRenderer.on(`${channel}:state`, (_event, value) => callback(value)),
  onLevel: (callback) => ipcRenderer.on(`${channel}:level`, (_event, value) => callback(value)),
});
