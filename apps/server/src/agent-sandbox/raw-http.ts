import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sendPinned } from "./raw-http-hop.js";
import { publicAddress, type OutboundRequest } from "./network.js";
import type { RawHttpInput, RawHttpOutput } from "./raw-http-schema.js";
export { rawHttpInputSchema, rawHttpOutputSchema, rawHttpToolName, type RawHttpInput, type RawHttpOutput } from "./raw-http-schema.js";
export type RawHttpRequest = OutboundRequest & { readonly bodyPresent: boolean };
export type Address = { address: string; family: number };
export type HopResponse = Omit<RawHttpOutput, "url" | "redirected">;
export type RawHttpNetwork = {
  resolve: (hostname: string) => Promise<Address[]>;
  send: (request: RawHttpRequest, address: Address, signal: AbortSignal, addresses?: Address[]) => Promise<HopResponse>;
};

const bodyHeaders = ["content-encoding", "content-language", "content-location", "content-type", "content-length"];
const credentials = ["authorization", "proxy-authorization", "cookie", "cookie2"];
const defaultNetwork: RawHttpNetwork = { resolve: hostname => lookup(hostname, { all: true }), send: sendPinned };

/** Request/Headers supply Fetch validation and normalization, without the page broker's caps. */
export function prepareRawHttpRequest(input: RawHttpInput): RawHttpRequest {
  const body = input.bodyBase64 === undefined ? undefined : Buffer.from(input.bodyBase64, "base64");
  if (body !== undefined && body.toString("base64") !== input.bodyBase64) throw new TypeError("Invalid HTTP request body encoding.");
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(input.method) || ["CONNECT", "TRACE", "TRACK"].includes(input.method.toUpperCase())) throw new TypeError("Invalid Fetch HTTP method.");
  const upper = input.method.toUpperCase();
  const method = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upper) ? upper : input.method;
  const request = new Request(input.url, { headers: input.headers });
  if (["GET", "HEAD"].includes(method) && body?.length) throw new TypeError("fetch() request with GET/HEAD method cannot have body.");
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Managed HTTP transport requires an HTTP(S) URL.");
  url.hash = "";
  const headers = Object.fromEntries(request.headers);
  if (headers["content-length"] !== undefined && headers["content-length"] !== String(body?.length ?? 0)) throw new TypeError("HTTP Content-Length does not match the request body.");
  const canonical = { url: url.href, method, headers: Object.freeze(headers), bodyBase64: body?.toString("base64") ?? "", bodyPresent: body !== undefined };
  return Object.freeze({ ...canonical, bodyBytes: body?.length ?? 0, sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") });
}

function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
  });
}

/** Full buffered Fetch transport; authorization precedes DNS and is excluded from its native 30s budget. */
export async function rawHttpRequest(input: RawHttpInput, authorize: (request: RawHttpRequest) => Promise<boolean>, signal: AbortSignal,
  options: { allowPrivate: boolean; network?: RawHttpNetwork; send?: RawHttpNetwork["send"] } ): Promise<RawHttpOutput> {
  const network = options.network ?? { ...defaultNetwork, ...(options.send ? { send: options.send } : {}) };
  let request = prepareRawHttpRequest(input);
  let remaining = 30_000;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    if (!await authorize(request)) throw new Error("HTTP access denied by LegalWork permissions.");
    signal.throwIfAborted();
    if (remaining <= 0) throw new DOMException("HTTP request timed out.", "TimeoutError");
    const started = performance.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException("HTTP request timed out.", "TimeoutError")), Math.max(0, remaining));
    const transportSignal = AbortSignal.any([signal, timeout.signal]);
    let response: HopResponse;
    try {
      const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
      // Resolve only after exact consent; connect directly to the validated IP.
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await aborted(network.resolve(hostname), transportSignal);
      transportSignal.throwIfAborted();
      if (performance.now() - started >= remaining) throw new DOMException("HTTP request timed out.", "TimeoutError");
      if (!addresses.length || addresses.some(({ address }) => !isIP(address) || !options.allowPrivate && !publicAddress(address))) throw new TypeError("The destination resolves to a local, private or reserved address.");
      response = await network.send(request, addresses[0], transportSignal, addresses);
      transportSignal.throwIfAborted();
      if (performance.now() - started >= remaining) throw new DOMException("HTTP request timed out.", "TimeoutError");
    } catch (error) {
      transportSignal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      remaining -= performance.now() - started;
    }
    if (![301, 302, 303, 307, 308].includes(response.status) || response.headers.location === undefined) return { ...response, url: request.url, redirected: redirects > 0 };
    // Fetch itself follows at most twenty redirects; this is its existing semantic limit.
    if (redirects === 20) throw new TypeError("fetch failed: redirect count exceeded.");
    const destination = new URL(response.headers.location, request.url);
    if (destination.protocol !== "http:" && destination.protocol !== "https:" || destination.username || destination.password) throw new TypeError("fetch failed: invalid redirect URL.");
    const headers = { ...request.headers };
    if (destination.origin !== new URL(request.url).origin) for (const name of credentials) delete headers[name];
    const rewrite = (response.status === 301 || response.status === 302) && request.method === "POST" || response.status === 303 && request.method !== "GET" && request.method !== "HEAD";
    if (rewrite) for (const name of bodyHeaders) delete headers[name];
    request = prepareRawHttpRequest({ url: destination.href, method: rewrite ? "GET" : request.method, headers,
      ...(!rewrite && request.bodyPresent ? { bodyBase64: request.bodyBase64 } : {}) });
  }
}

