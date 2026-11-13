/** Navigation schedules work; neither loading nor the debounce owns a capture lease. */
export function installBrowserPreview(contents, { enabled, busy, capture, publish }) {
  let timer, running = false, pending = false, closed = false, generation = 0;
  const stop = new AbortController();
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const arm = () => {
    clear();
    timer = setTimeout(() => { void refresh(); }, 300);
    timer.unref?.();
  };
  const request = () => {
    if (closed || !enabled() || contents.getURL() === "about:blank") return;
    pending = true;
    arm();
  };
  async function refresh() {
    timer = undefined;
    if (closed || !pending || !enabled()) { pending = false; return; }
    if (running || busy()) { arm(); return; }
    pending = false;
    running = true;
    const current = generation;
    try {
      const image = await capture(stop.signal);
      const valid = () => !closed && current === generation && enabled();
      if (valid() && image) publish(image, valid);
    } catch { /* Keep the last preview; a decorative capture never fails navigation. */ }
    finally {
      running = false;
      if (pending && !closed) arm();
    }
  }
  const navigating = (event, _url, _inPlace, isMainFrame) => {
    if (event.isMainFrame === false || isMainFrame === false) return;
    generation++;
    pending = false;
    clear();
  };
  const inPage = (event, _url, isMainFrame) => {
    if (event.isMainFrame === false || isMainFrame === false) return;
    generation++;
    request();
  };
  const dispose = () => {
    closed = true;
    clear();
    stop.abort(new Error("Browser preview is closed."));
    for (const [name, listener] of listeners) contents.removeListener(name, listener);
  };
  const listeners = [["did-start-navigation", navigating], ["did-redirect-navigation", navigating],
    ["dom-ready", request], ["did-finish-load", request], ["did-navigate-in-page", inPage], ["destroyed", dispose]];
  for (const [name, listener] of listeners) contents.on(name, listener);
  return { dispose };
}
