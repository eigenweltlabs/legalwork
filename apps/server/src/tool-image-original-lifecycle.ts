import { findApiError } from "./errors.js";

/** The host binds these methods to one verified managed history namespace. */
export type ToolImageOriginalLifecycleStore = {
  indexedSessionIDs(): Promise<string[]>;
  deletedSessionIDs(): Promise<string[]>;
  removeSessions(sessionIDs: readonly string[]): Promise<void>;
  retryReferenceDeletions(): Promise<void>;
};
export type ToolImageOriginalLifecycleSource = {
  assertCurrent(): void;
  events(signal: AbortSignal): AsyncIterable<{ type: string; data: unknown }>;
  session(sessionID: string, signal: AbortSignal): Promise<void>;
};

function pause(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Native deletion can bypass the app's DELETE route. Reconnect reconciliation
 * examines only indexed chats; an unavailable engine is never proof of deletion. */
export function startToolImageOriginalLifecycle(options: {
  store: ToolImageOriginalLifecycleStore;
  source: () => ToolImageOriginalLifecycleSource;
  report: (error: unknown) => void;
}) {
  const controller = new AbortController();
  async function reconcile(source: ToolImageOriginalLifecycleSource, signal: AbortSignal) {
    source.assertCurrent();
    await options.store.retryReferenceDeletions();
    signal.throwIfAborted();
    const deleted = await options.store.deletedSessionIDs();
    signal.throwIfAborted();
    source.assertCurrent();
    if (deleted.length) await options.store.removeSessions(deleted);
    for (const sessionID of await options.store.indexedSessionIDs()) {
      signal.throwIfAborted();
      try { await source.session(sessionID, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (findApiError(error)?.status !== 404) throw error;
        source.assertCurrent();
        await options.store.removeSessions([sessionID]);
      }
    }
  }
  const task = (async () => {
    let delay = 100;
    while (!controller.signal.aborted) {
      const attempt = new AbortController();
      const signal = AbortSignal.any([controller.signal, attempt.signal]);
      try {
        const source = options.source();
        let connected = false;
        for await (const event of source.events(signal)) {
          signal.throwIfAborted();
          // Subscribe first, then reconcile. Deletions during the check remain
          // queued on this stream. The native stream starts with server.connected.
          if (!connected) { connected = true; await reconcile(source, signal); }
          source.assertCurrent();
          delay = 100;
          if (event.type !== "session.deleted") continue;
          const data = event.data;
          if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string" || !data.sessionID)
            throw new Error("Native image cleanup received an invalid session deletion.");
          await options.store.removeSessions([data.sessionID]);
        }
      } catch (error) {
        if (!controller.signal.aborted) options.report(error);
      } finally { attempt.abort(); }
      if (!controller.signal.aborted) await pause(delay, controller.signal);
      delay = Math.min(delay * 2, 2000);
    }
  })();
  return {
    async close() { controller.abort(); await task; },
  };
}
