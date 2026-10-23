/** Bound concurrent file/network work and drain the batch before reporting a failure. */
export async function syncBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const batch = await Promise.allSettled(items.slice(offset, offset + size).map(run));
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}
