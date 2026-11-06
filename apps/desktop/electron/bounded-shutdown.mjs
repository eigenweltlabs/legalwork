/** A graceful shutdown may wait for cleanup, but a stuck worker or renderer
 * must not prevent Quit forever. The caller owns the final process exit. */
export function boundedShutdown(stop, forceExit, timeoutMs = 10_000) {
  const timer = setTimeout(forceExit, timeoutMs);
  return Promise.resolve().then(stop).finally(() => clearTimeout(timer));
}
