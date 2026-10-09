/** Serialize refreshes and discard results superseded while awaiting I/O.
 * Every caller waits until the latest requested refresh has finished. */
export function createCoalescedRefresh(task: (isCurrent: () => boolean) => Promise<void>) {
  let revision = 0;
  let pending: Promise<void> | null = null;
  return () => {
    revision++;
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        try {
          let started: number;
          do {
            started = revision;
            await task(() => revision === started);
          } while (revision !== started);
        } finally {
          pending = null;
        }
      });
    }
    return pending;
  };
}
