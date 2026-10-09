/** One approval at a time, only while its host and requesting command are alive. */
export function createHostApprovalHandler({ getWindow, showDialog = presentHostApproval }) {
  let queue = Promise.resolve();
  return (request, signal) => {
    const present = async () => {
      const window = getWindow?.();
      if (signal.aborted || !window || window.isDestroyed()) return "deny";
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      window.once("closed", abort);
      try {
        const reply = await showDialog(window, request, controller.signal);
        return !controller.signal.aborted && !window.isDestroyed() && reply === "allow" ? "allow" : "deny";
      } catch {
        return "deny";
      } finally {
        signal.removeEventListener("abort", abort);
        window.removeListener("closed", abort);
      }
    };
    const result = queue.then(present);
    queue = result.then(() => {}, () => {});
    return result;
  };
}

/** Only the trusted host window's main frame may answer its active request. */
export function presentHostApproval(window, request, signal) {
  if (signal.aborted || window.isDestroyed()) return Promise.resolve("deny");
  const contents = window.webContents;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reply = "deny") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      contents.ipc.removeListener("legalwork:approval:reply", respond);
      contents.removeListener("render-process-gone", abort);
      contents.removeListener("destroyed", abort);
      contents.removeListener("did-start-navigation", navigate);
      if (!contents.isDestroyed()) contents.send("legalwork:approval:dismiss", request.id);
      resolve(reply);
    };
    const abort = () => finish();
    const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) finish(); };
    const respond = (event, id, reply) => {
      if (event.senderFrame !== contents.mainFrame || id !== request.id || (reply !== "allow" && reply !== "deny")) return;
      finish(reply);
    };
    signal.addEventListener("abort", abort, { once: true });
    contents.ipc.on("legalwork:approval:reply", respond);
    contents.once("render-process-gone", abort);
    contents.once("destroyed", abort);
    contents.on("did-start-navigation", navigate);
    try { contents.send("legalwork:approval:show", request); }
    catch { finish(); }
    if (signal.aborted) finish();
  });
}
