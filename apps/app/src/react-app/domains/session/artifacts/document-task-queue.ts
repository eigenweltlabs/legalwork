export type DocumentTaskOptions = { signal?: AbortSignal; deadline?: number };

export function checkDocumentTask(options: DocumentTaskOptions = {}) {
  options.signal?.throwIfAborted();
  if (options.deadline !== undefined && options.deadline <= Date.now()) throw new DOMException("Document request expired before it could run.", "TimeoutError");
}

/** Reads and writes on one live draft must finish in order, including saving.
 * Other documents can run independently. A failed call never poisons the queue. */
export function createDocumentTaskQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>, options: DocumentTaskOptions = {}): Promise<T> => {
    const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => { checkDocumentTask(options); return run(); });
    pending.set(key, result);
    void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => {});
    // Keep the actual job in the ordering chain even when its caller cancels.
    // Another writer may start only after the running job's cleanup finishes.
    const signal = options.signal;
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  };
}
