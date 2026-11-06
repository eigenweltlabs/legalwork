/** One export in flight and one reusable result for the current revision.
 * Waiting saves/checkpoints request the latest revision instead of building a
 * backlog of full exports. A failed export never poisons later attempts. */
export function createDocumentExport<T>(revision: () => number, serialize: () => Promise<T>, reusable: (value: T) => boolean = () => true) {
  let active: Promise<{ revision: number; value: T }> | null = null;
  let cached: { revision: number; value: T } | null = null;
  const read = (): Promise<T> => {
    const current = revision();
    if (cached?.revision === current) return Promise.resolve(cached.value);
    if (active) return active.then(result => result.revision === revision() ? result.value : read());
    const operation = (async () => serialize())().then(value => {
      const result = { revision: current, value };
      if (reusable(value)) cached = result;
      return result;
    });
    active = operation;
    void operation.finally(() => { if (active === operation) active = null; }).catch(() => {});
    return operation.then(result => result.value);
  };
  return { read };
}
