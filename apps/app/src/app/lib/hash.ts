/** Deterministic djb2 string hash, base36-encoded. Fast and stable across
 * releases; NOT cryptographic — use only for grouping/correlation keys. */
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
