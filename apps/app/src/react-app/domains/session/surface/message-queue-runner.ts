/** One runner per session, independent of whichever conversation is visible.
 * `send` resolves only after the engine finishes the entire turn. */
export function createMessageQueueRunner<T extends { id: string }>(options: {
  next: () => T | undefined;
  paused: () => boolean;
  isIdle: () => Promise<boolean>;
  take: (item: T) => void;
  send: (item: T) => Promise<void>;
  failed: (error: unknown, item?: T) => void;
  drained: () => void;
}) {
  let running = false;
  let disposed = false;
  const wake = async () => {
    if (running || disposed) return;
    running = true;
    let taken: T | undefined;
    try {
      while (!disposed && !options.paused()) {
        const item = options.next();
        if (!item) break;
        if (!await options.isIdle()) break;
        // The user may edit/delete/pause while the status request is in flight.
        if (disposed || options.paused()) break;
        if (options.next() !== item) continue;
        taken = item;
        options.take(item);
        await options.send(item);
        taken = undefined;
      }
    } catch (error) {
      options.failed(error, taken);
    } finally {
      running = false;
      if (!options.next()) options.drained();
    }
  };
  return { wake, dispose: () => { disposed = true; } };
}
