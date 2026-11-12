import { setTimeout as delay } from "node:timers/promises";
import { RisRateLimitError, RisUpstreamError } from "../infrastructure/errors.js";

/** One queue for the entire server process, including content and health calls.
 * No response cache: each completed operation reads RIS again. */
export class RisRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private nextRequestAt = 0;

  constructor(private readonly options: {
    intervalMs?: number;
    maxPending?: number;
    now?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {}) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.pending >= (this.options.maxPending ?? 48)) throw new RisRateLimitError(2000);
    this.pending++;
    const previous = this.tail;
    const task = previous.then(async () => {
      signal.throwIfAborted();
      const now = this.options.now ?? Date.now;
      const wait = Math.max(0, this.nextRequestAt - now());
      if (wait) await (this.options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(wait, signal);
      signal.throwIfAborted();
      try { return await operation(); }
      finally { this.nextRequestAt = now() + (this.options.intervalMs ?? 2000); }
    }).finally(() => { this.pending--; });
    this.tail = task.then(() => {}, () => {});
    // Let a cancelled caller return immediately, while retaining its place
    // behind the preceding task so cancellation cannot create parallel fetches.
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      task.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }
}

export const risRequestQueue = new RisRequestQueue();

export function allowedRisUrl(value: string, content = false): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RisUpstreamError("RIS returned an invalid source URL."); }
  const hosts = content ? ["ogd.ris.bka.gv.at", "www.ris.bka.gv.at", "ris.bka.gv.at"] : ["data.bka.gv.at"];
  const pathAllowed = content ? /^\/(Dokumente\/|eli\/|Dokument\.wxe$)/i.test(url.pathname) : url.pathname.startsWith("/ris/api/v2.6/");
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.port || url.username || url.password || !pathAllowed)
    throw new RisUpstreamError("RIS returned a source URL outside the permitted official RIS endpoints.");
  url.hash = "";
  return url;
}

export async function boundedText(response: Response, maxBytes = 8 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new RisUpstreamError("RIS response is too large. Narrow the query or open its source link.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, result = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new RisUpstreamError("RIS response is too large. Narrow the query or open its source link.");
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
