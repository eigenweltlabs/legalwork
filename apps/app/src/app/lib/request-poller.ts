type PollOptions = {
  intervalMs: number | (() => number | false);
  maxBackoffMs?: number;
  pauseWhenHidden?: boolean;
  schedule?: (callback: () => void, ms: number) => () => void;
};

/** One request at a time, with coalesced event wakeups and backoff after failures. */
export function startRequestPolling(run: (signal: AbortSignal) => Promise<unknown>, options: PollOptions) {
  const controller = new AbortController();
  let running = false;
  let pending = false;
  let failures = 0;
  let cancelTimer: (() => void) | undefined;
  const schedule = options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });
  const hidden = () => options.pauseWhenHidden !== false && typeof document !== "undefined" && document.visibilityState === "hidden";
  const interval = () => typeof options.intervalMs === "function" ? options.intervalMs() : options.intervalMs;

  const wake = () => {
    if (controller.signal.aborted) return;
    cancelTimer?.();
    cancelTimer = undefined;
    if (hidden()) return;
    if (running) { pending = true; return; }
    running = true;
    void (async () => {
      try {
        await run(controller.signal);
        failures = 0;
      } catch {
        failures++;
      } finally {
        running = false;
        if (controller.signal.aborted) return;
        const next = interval();
        const delay = failures
          ? Math.min(options.maxBackoffMs ?? 60_000, Math.max(next || 3000, 1000) * 2 ** Math.min(failures, 6))
          : pending ? 0 : next;
        pending = false;
        if (delay !== false && !hidden()) cancelTimer = schedule(wake, delay);
      }
    })();
  };
  const visible = () => { if (!hidden()) wake(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible);
  wake();
  return {
    wake,
    stop: () => {
      controller.abort();
      cancelTimer?.();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible);
    },
  };
}
