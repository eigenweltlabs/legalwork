const { contextBridge, ipcRenderer } = require("electron");

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("legalwork:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

contextBridge.exposeInMainWorld("__LEGALWORK_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("legalwork:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("legalwork:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("legalwork:menu-overlay:close", { requestId });
  },
});
