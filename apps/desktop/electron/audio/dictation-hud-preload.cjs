const { contextBridge, ipcRenderer } = require("electron");
const channel = "legalwork:dictation-hud";

contextBridge.exposeInMainWorld("dictationHud", {
  action: (action, version, matterId, note) => ipcRenderer.send(`${channel}:action`, action, version, matterId, note),
  pointer: (interactive) => ipcRenderer.send(`${channel}:pointer`, interactive),
  drag: (phase, anchor) => ipcRenderer.send(`${channel}:drag`, phase, anchor),
  onCursor: (callback) => ipcRenderer.on(`${channel}:cursor`, (_event, value) => callback(value)),
  onState: (callback) => ipcRenderer.on(`${channel}:state`, (_event, value) => callback(value)),
  onLevel: (callback) => ipcRenderer.on(`${channel}:level`, (_event, value) => callback(value)),
});
