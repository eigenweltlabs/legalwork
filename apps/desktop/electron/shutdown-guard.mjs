/** Ask live app renderers before any native teardown or update installation. */
export function createShutdownGuard({ getWindows, isQuitting }) {
  let pending = null;
  const closing = new WeakSet();
  const checkingClose = new WeakSet();
  const confirm = (action, windows = undefined) => {
    // A second window or a different exit action must obtain its own consent.
    if (pending) return Promise.resolve(false);
    const promise = (async () => {
      // Recheck earlier windows: they can receive edits while another modal is open.
      while (true) {
        let prompted = false;
        for (const window of windows ?? getWindows()) {
          if (!window || window.isDestroyed()) continue;
          try {
            const dirty = await window.webContents.executeJavaScript('Boolean(window.__LEGALWORK_SHUTDOWN__?.hasUnsavedChanges())');
            if (!dirty) continue;
            prompted = true;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
            const approved = await window.webContents.executeJavaScript(`window.__LEGALWORK_SHUTDOWN__?.request(${JSON.stringify(action)}) ?? false`);
            if (approved !== true) return false;
          } catch {
            if (!window.isDestroyed()) return false;
          }
        }
        if (!prompted) return true;
      }
    })();
    pending = { promise };
    void promise.finally(() => { if (pending?.promise === promise) pending = null; });
    return promise;
  };
  const protect = window => {
    window.on("close", event => {
      if (isQuitting() || closing.has(window)) return;
      event.preventDefault();
      if (checkingClose.has(window)) return;
      checkingClose.add(window);
      void confirm("close", [window]).then(approved => {
        checkingClose.delete(window);
        if (!approved || window.isDestroyed()) return;
        closing.add(window);
        try { window.close(); } finally { closing.delete(window); }
      });
    });
  };
  return { confirm, protect };
}
