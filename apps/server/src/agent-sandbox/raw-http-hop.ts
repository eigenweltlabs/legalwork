import type { LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import { getCACertificates } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import { Client, ProxyAgent } from "undici-transport";
import { rawHttpProxy } from "./raw-http-proxy.js";
import type { Address, HopResponse, RawHttpRequest } from "./raw-http.js";

export async function sendPinned(input: RawHttpRequest, address: Address, signal: AbortSignal, addresses: Address[] = [address], environment: NodeJS.ProcessEnv = process.env): Promise<HopResponse> {
  const url = new URL(input.url);
  signal.throwIfAborted();
  const proxy = rawHttpProxy(url, environment);
  const pinned = new URL(url);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const options = { maxHeaderSize: Number.MAX_SAFE_INTEGER, maxResponseSize: -1, headersTimeout: 0, bodyTimeout: 0, connectTimeout: 0, allowH2: false };
  const servername = url.hostname.replace(/^\[|\]$/g, "");
  // Public runtime trust APIs retain bundled/default/extra roots and add the
  // normal OS store. LegalWork does not read certificate files or directories.
  const ca = url.protocol === "https:" || proxy?.protocol === "https:"
    ? [...getCACertificates("default"), ...getCACertificates("system")] : undefined;
  const tls = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== servername) { callback(new Error("HTTP connection requested an unapproved DNS name."), "", 0); return; }
    if (options.all) callback(null, addresses);
    else callback(null, address.address, address.family);
  };
  const forward = proxy && url.protocol === "http:";
  // HTTP uses ordinary absolute-form forwarding, including through TLS proxies.
  // Undici 7's forwarding wrapper drops statusText, so use its public Client directly.
  const client = forward ? new Client(proxy.origin, { ...options, connect: { ...tls, servername: proxy.hostname.replace(/^\[|\]$/g, ""), timeout: 0, signal } })
    : proxy ? new ProxyAgent({ ...options, uri: proxy.href, requestTls: { ...tls, servername, timeout: 0, signal }, proxyTls: { ...tls, timeout: 0, signal } })
    : new Client(url.origin, { ...options, connect: { ...tls, servername, timeout: 0, signal, lookup, autoSelectFamily: true } });
  let stopBody: (() => void) | undefined;
  try {
    const headers = { ...input.headers };
    if (forward && (proxy.username || proxy.password)) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    // Match Fetch's default compression negotiation; caller headers remain authoritative.
    if (headers["accept-encoding"] === undefined) headers["accept-encoding"] = "gzip, deflate, br";
    if (input.bodyPresent && headers["content-length"] === undefined && headers["transfer-encoding"] === undefined) headers["content-length"] = String(input.bodyBytes);
    const response = await client.request({ origin: forward ? proxy.origin : proxy ? pinned.origin : url.origin, path: forward ? pinned.href : url.pathname + url.search,
      method: input.method, headers: { host: url.host, ...headers }, signal,
      body: input.bodyPresent ? Buffer.from(input.bodyBase64, "base64") : null });
    return await new Promise<HopResponse>((resolve, reject) => {
      const res = response.body;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && headers.location !== undefined) {
        // Fetch follows on headers, cancelling the discarded redirect body.
        res.on("error", () => {}); // Undici reports this deliberate cancellation asynchronously.
        res.destroy();
        resolve({ status: response.statusCode, statusText: response.statusText, headers, bodyBase64: "" });
        return;
      }
      let body: Readable = res;
      // Fetch returns decoded bytes while preserving the response header view.
      const encodings = headers["content-encoding"]?.split(",").map(value => value.trim().toLowerCase()) ?? [];
      if (input.method !== "HEAD" && ![204, 205, 304].includes(response.statusCode) && encodings.every(value => ["gzip", "x-gzip", "deflate", "br"].includes(value))) {
        for (const encoding of encodings.reverse()) {
          const decoder = encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? fetchInflate() : createGunzip();
          body.on("error", error => decoder.destroy(error));
          body = body.pipe(decoder);
        }
      }
      const parts: Buffer[] = [];
      const stop = () => { const error = signal.reason instanceof Error ? signal.reason : new Error("HTTP request cancelled."); body.destroy(error); res.destroy(error); reject(error); };
      stopBody = stop;
      signal.addEventListener("abort", stop, { once: true });
      body.on("data", chunk => { parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      body.on("error", error => { signal.removeEventListener("abort", stop); reject(error); });
      body.on("end", () => { signal.removeEventListener("abort", stop); resolve({ status: response.statusCode, statusText: response.statusText, headers, bodyBase64: Buffer.concat(parts).toString("base64") }); });
      if (signal.aborted) stop();
    });
  } finally {
    if (stopBody) signal.removeEventListener("abort", stopBody);
    await client.destroy();
  }
}

/** Fetch accepts legacy raw deflate as well as the RFC zlib wrapper. */
function fetchInflate(): Transform {
  let decoder: ReturnType<typeof createInflate> | undefined;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!decoder) {
        decoder = (chunk[0] & 15) === 8 ? createInflate() : createInflateRaw();
        decoder.on("data", value => this.push(value));
        decoder.once("error", error => this.destroy(error));
      }
      decoder.write(chunk, done);
    },
    flush(done) {
      if (!decoder) { done(); return; }
      decoder.once("end", done); decoder.end();
    },
    destroy(error, done) { decoder?.destroy(); done(error); },
  });
}
