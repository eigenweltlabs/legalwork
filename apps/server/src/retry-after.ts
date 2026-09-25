/** HTTP Retry-After accepts either seconds or an HTTP date. */
export function retryAfterMs(value: string | null | undefined) {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
