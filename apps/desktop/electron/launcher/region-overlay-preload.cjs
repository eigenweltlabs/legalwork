const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("regionOverlay", {
  select: (rect) => ipcRenderer.send("legalwork:launcher:region", { type: "select", ...rect }),
  cancel: () => ipcRenderer.send("legalwork:launcher:region", { type: "cancel" }),
});
