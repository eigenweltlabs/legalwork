/** Stop waiting without letting a late native result resume the old operation. */
export function browserAbortable(operation, signal) {
  signal?.throwIfAborted();
  const pending = operation();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(pending).then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** Screenshot viewport/parent changes must not overlap on the same page.
 * No queue length or deadline is imposed. Active operations observe the supplied
 * signal and finish their resource cleanup before the next operation starts. */
export function createBrowserCaptureQueue() {
  const pages = new WeakMap();
  const closed = new WeakSet();
  const capture = (contents, signal, operation) => new Promise((resolve, reject) => {
    if (contents.isDestroyed() || closed.has(contents)) { reject(new Error("Browser tab is closed.")); return; }
    if (signal?.aborted) { reject(signal.reason); return; }
    let page = pages.get(contents);
    if (!page) {
      page = { active: null, waiting: new Set(), destroyed: () => capture.close(contents) };
      pages.set(contents, page);
      contents.once("destroyed", page.destroyed);
    }
    const controller = new AbortController();
    const detach = () => signal?.removeEventListener("abort", abort);
    const idle = () => {
      if (page.active || page.waiting.size) return;
      contents.removeListener("destroyed", page.destroyed);
      pages.delete(contents);
    };
    const item = { operation, resolve, reject, controller, detach, cancel: reason => {
      controller.abort(reason);
      if (page.active === item) { reject(reason); return; }
      if (!page.waiting.delete(item)) return;
      detach(); reject(reason); idle();
    } };
    const abort = () => item.cancel(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    page.waiting.add(item);
    function next() {
      if (page.active) return;
      const pending = page.waiting.values().next().value;
      if (!pending) { idle(); return; }
      page.waiting.delete(pending);
      page.active = pending;
      void (async () => {
        try { pending.resolve(await pending.operation(pending.controller.signal)); }
        catch (error) { pending.reject(error); }
        finally { pending.detach(); page.active = null; next(); }
      })();
    }
    next();
  });
  capture.close = contents => {
    closed.add(contents);
    const page = pages.get(contents);
    if (!page) return;
    const reason = new Error("Browser tab is closed.");
    page.active?.cancel(reason);
    for (const item of page.waiting) item.cancel(reason);
  };
  return capture;
}
