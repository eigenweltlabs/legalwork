import type { OAuthFetch } from "./oauth.js";

export type GmailTransportErrorCode = "invalid_input" | "invalid_response" | "response_too_large" | "raw_too_large"
  | "access_token_rejected" | "reconsent_required" | "forbidden" | "rate_limited" | "quota_exceeded"
  | "transient" | "not_found" | "request_rejected" | "timeout" | "cancelled" | "consumer_failed";
export class GmailTransportError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: GmailTransportErrorCode, readonly retryAfterMs: number | null = null) {
    super(`mail_gmail_${code}`);
    this.retryable = code === "rate_limited" || code === "transient" || code === "timeout";
  }
}
export type GmailLabel = { id: string; name: string; type: "system" | "user" };
export type GmailMessagePage = { messages: { id: string; threadId: string }[]; nextPageToken: string | null; resultSizeEstimate: number | null };
export type GmailRawMetadata = { id: string; threadId: string; labelIds: string[]; historyId: string; internalDate: string; sizeEstimate: number; rawBytes: number };
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MiB = 1024 * 1024;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value) && value !== "." && value !== ".."; }
function pageToken(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function decimal(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9][0-9]{0,31})$/.test(value); }
function retryAfter(value: string | null): number | null {
  if (!value || value.length > 128) return null;
  const delay = /^[0-9]+$/.test(value) ? Number(value) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Math.max(0, Date.parse(value) - Date.now()) : NaN;
  return Number.isSafeInteger(delay) && delay >= 0 ? delay : null;
}
function reject(code: GmailTransportErrorCode): never { throw new GmailTransportError(code); }
async function json(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {}); return reject("invalid_response");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) return reject("cancelled");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) return reject("response_too_large");
      if (!chunk.value.byteLength || chunks.length >= 65536) return reject("invalid_response");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return reject("invalid_response"); }
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}
/** Validates base64url alphabet, optional canonical padding, unused bits and decoded size before delivery. */
function rawLength(raw: unknown, limit: number): number {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return reject("invalid_response");
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const lengthWithoutPadding = raw.length - padding;
  const remainder = lengthWithoutPadding % 4;
  if (remainder === 1 || (padding > 0 && (raw.length % 4 !== 0 || padding !== 4 - remainder))) return reject("invalid_response");
  const last = ALPHABET.indexOf(raw[lengthWithoutPadding - 1] ?? "");
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) return reject("invalid_response");
  const length = Math.floor(lengthWithoutPadding * 3 / 4);
  if (length > limit) return reject("raw_too_large");
  return length;
}

/** Read-only trusted worker transport. No token refresh, persistence, pagination loop, retries or MIME parsing. */
export class GmailReadTransport {
  private readonly accessToken: string;
  private readonly fetch: OAuthFetch;
  private readonly timeoutMs: number;
  private readonly maxRawBytes: number;
  constructor(options: { accessToken: string; fetch?: OAuthFetch; timeoutMs?: number; maxRawBytes?: number }) {
    this.timeoutMs = options.timeoutMs ?? 30000; this.maxRawBytes = options.maxRawBytes ?? 64 * MiB;
    if (typeof options.accessToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(options.accessToken)
      || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 120000
      || !Number.isInteger(this.maxRawBytes) || this.maxRawBytes < 1 || this.maxRawBytes > 128 * MiB) throw new GmailTransportError("invalid_input");
    this.accessToken = options.accessToken; this.fetch = options.fetch ?? fetch;
  }
  private async run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal, checkpoint: () => void) => Promise<T>): Promise<T> {
    if (signal?.aborted) return reject("cancelled");
    const controller = new AbortController(); let timedOut = false;
    const expiresAt = Date.now() + this.timeoutMs;
    const checkpoint = () => {
      if (Date.now() >= expiresAt) { timedOut = true; controller.abort(); return reject("timeout"); }
      if (controller.signal.aborted) return reject("cancelled");
    };
    let rejectDeadline: (error: GmailTransportError) => void = () => {};
    const deadline = new Promise<never>((_, rejectPromise) => { rejectDeadline = rejectPromise; });
    const abort = () => { controller.abort(); rejectDeadline(new GmailTransportError("cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectDeadline(new GmailTransportError("timeout")); }, this.timeoutMs);
    try { const result = await Promise.race([work(controller.signal, checkpoint), deadline]); checkpoint(); return result; }
    catch (error) {
      if (timedOut) return reject("timeout"); if (signal?.aborted) return reject("cancelled");
      if (error instanceof GmailTransportError) throw error;
      return reject("transient");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  private async get(url: string, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) return reject("cancelled");
    const response = await this.fetch(url, { method: "GET", redirect: "error", signal,
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } });
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); return reject("cancelled"); }
    if (response.status !== 200 && response.status !== 403) {
      void response.body?.cancel().catch(() => {});
      throw new GmailTransportError(response.status === 401 ? "access_token_rejected" : response.status === 404 ? "not_found"
        : response.status === 429 ? "rate_limited" : response.status === 408 || response.status >= 500 ? "transient" : "request_rejected", retryAfter(response.headers.get("retry-after")));
    }
    if (response.status === 403) {
      let data: unknown;
      try { data = await json(response, 65536, signal); } catch { return reject("forbidden"); }
      const reasons = record(data) && record(data.error) && Array.isArray(data.error.errors) && data.error.errors.length <= 32
        ? data.error.errors.flatMap(item => record(item) && typeof item.reason === "string" ? [item.reason] : []) : [];
      const code = reasons.includes("dailyLimitExceeded") || reasons.includes("quotaExceeded") ? "quota_exceeded"
        : reasons.includes("rateLimitExceeded") || reasons.includes("userRateLimitExceeded") ? "rate_limited"
        : reasons.includes("insufficientPermissions") ? "reconsent_required" : "forbidden";
      throw new GmailTransportError(code, retryAfter(response.headers.get("retry-after")));
    }
    const data = await json(response, limit, signal);
    if (!record(data) || data.error !== undefined) return reject("invalid_response");
    return data;
  }
  listLabels(options: { signal?: AbortSignal } = {}): Promise<{ labels: GmailLabel[] }> {
    return this.run(options.signal, async signal => {
      const data = await this.get(`${BASE}/labels`, 4 * MiB, signal);
      if (data.nextPageToken !== undefined || data.nextLink !== undefined) return reject("invalid_response");
      const values = data.labels === undefined ? [] : data.labels;
      if (!Array.isArray(values) || values.length > 10000) return reject("invalid_response");
      const seen = new Set<string>();
      const labels = values.map((value): GmailLabel => {
        if (!record(value) || !id(value.id) || typeof value.name !== "string" || !value.name.length || Buffer.byteLength(value.name) > 4096
          || (value.type !== "system" && value.type !== "user") || seen.has(value.id)) return reject("invalid_response");
        seen.add(value.id); return { id: value.id, name: value.name, type: value.type };
      });
      return { labels };
    });
  }
  listMessages(options: { pageToken?: string; pageSize?: number; signal?: AbortSignal } = {}): Promise<GmailMessagePage> {
    const size = options.pageSize ?? 100;
    if (!Number.isInteger(size) || size < 1 || size > 500 || (options.pageToken !== undefined && !pageToken(options.pageToken))) return Promise.reject(new GmailTransportError("invalid_input"));
    const inputToken = options.pageToken;
    const url = new URL(`${BASE}/messages`); url.searchParams.set("includeSpamTrash", "true"); url.searchParams.set("maxResults", String(size));
    if (inputToken !== undefined) url.searchParams.set("pageToken", inputToken);
    return this.run(options.signal, async signal => {
      const data = await this.get(url.toString(), MiB, signal);
      const values = data.messages === undefined ? [] : data.messages;
      if (!Array.isArray(values) || values.length > size || data.nextLink !== undefined
        || (data.nextPageToken !== undefined && (!pageToken(data.nextPageToken) || data.nextPageToken === inputToken))
        || (data.resultSizeEstimate !== undefined && (!integer(data.resultSizeEstimate) || data.resultSizeEstimate > 4294967295))) return reject("invalid_response");
      const seen = new Set<string>();
      const messages = values.map(value => {
        if (!record(value) || !id(value.id) || !id(value.threadId) || seen.has(value.id)) return reject("invalid_response");
        seen.add(value.id); return { id: value.id, threadId: value.threadId };
      });
      return { messages, nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null,
        resultSizeEstimate: typeof data.resultSizeEstimate === "number" ? data.resultSizeEstimate : null };
    });
  }
  /** Chunks are provisional until this promise succeeds and caller durably finalizes its own sink. */
  consumeRaw(messageId: string, consume: (chunk: Uint8Array) => Promise<void>, options: { signal?: AbortSignal } = {}): Promise<GmailRawMetadata> {
    if (!id(messageId) || typeof consume !== "function") return Promise.reject(new GmailTransportError("invalid_input"));
    return this.run(options.signal, async (signal, checkpoint) => {
      const data = await this.get(`${BASE}/messages/${encodeURIComponent(messageId)}?format=raw`, Math.ceil(this.maxRawBytes / 3) * 4 + 65536, signal);
      const labels = data.labelIds === undefined ? [] : data.labelIds;
      if (data.id !== messageId || !id(data.threadId) || !Array.isArray(labels) || labels.length > 10000 || !labels.every(id)
        || new Set(labels).size !== labels.length || !decimal(data.historyId) || !decimal(data.internalDate)
        || !Number.isSafeInteger(Number(data.internalDate)) || !integer(data.sizeEstimate)) return reject("invalid_response");
      const rawBytes = rawLength(data.raw, this.maxRawBytes);
      if (typeof data.raw !== "string") return reject("invalid_response");
      // 64 KiB encoded blocks decode to at most 48 KiB; no full decoded MIME allocation.
      for (let offset = 0; offset < data.raw.length; offset += 65536) {
        checkpoint();
        const chunk = Buffer.from(data.raw.slice(offset, offset + 65536), "base64url");
        try { await consume(chunk); } catch { return reject("consumer_failed"); }
      }
      checkpoint();
      return { id: messageId, threadId: data.threadId, labelIds: labels, historyId: data.historyId, internalDate: data.internalDate, sizeEstimate: data.sizeEstimate, rawBytes };
    });
  }
}
