import { z } from "zod";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createHash } from "node:crypto";

export const networkModeSchema = z.enum(["allow", "block", "approve"]);
export type NetworkMode = z.infer<typeof networkModeSchema>;

export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type OutboundRequest = Readonly<{
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  bodyBase64: string;
  bodyBytes: number;
  sha256: string;
}>;

export type OutboundResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

// Includes loopback, LAN, link-local, cloud metadata, transition mechanisms,
// multicast and reserved ranges. A domain's resolution cannot broaden access.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] satisfies Array<[string, number]>) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] satisfies Array<[string, number]>) blockedV6.addSubnet(network, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blockedV4.check(address, "ipv4") : family === 6 && !blockedV6.check(address, "ipv6");
}

const hopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

export function prepareOutboundRequest(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64: string;
}, options: { allowPrivate?: boolean } = {}): OutboundRequest {
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("The sandbox permits HTTP(S) requests without URL credentials or fragments.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!options.allowPrivate && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      (isIP(hostname) && !publicAddress(hostname)))) throw new Error("Access to local or private network addresses is blocked.");
  const method = input.method.toUpperCase();
  if (!/^[A-Z]{1,32}$/.test(method) || method === "CONNECT" || method === "TRACE") {
    throw new Error("Unsupported sandbox HTTP method.");
  }
  if (input.bodyBase64.length > Math.ceil(MAX_REQUEST_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bodyBase64)) {
    throw new Error("Invalid or oversized sandbox request body.");
  }
  const body = Buffer.from(input.bodyBase64, "base64");
  if (body.length > MAX_REQUEST_BYTES) throw new Error("Sandbox request body is too large.");
  const connection = Object.entries(input.headers).find(([key]) => key.toLowerCase() === "connection")?.[1] ?? "";
  const removed = new Set([...hopHeaders, ...connection.split(",").map((name) => name.trim().toLowerCase())]);
  const headers: Record<string, string> = {};
  if (Object.entries(input.headers).length > 100) throw new Error("Too many sandbox request headers.");
  for (const [key, value] of Object.entries(input.headers)) {
    const name = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n\0]/.test(value) || value.length > 8192) {
      throw new Error("Invalid sandbox request header.");
    }
    if (!removed.has(name)) headers[name] = value;
  }
  headers.host = url.host;
  headers["content-length"] = String(body.length);
  headers.connection = "close";
  const canonical = { url: url.href, method, headers: Object.freeze(headers), bodyBase64: body.toString("base64") };
  return Object.freeze({ ...canonical, bodyBytes: body.length,
    sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") });
}

type Address = { address: string; family: number };
type NetworkDependencies = {
  resolve: (hostname: string) => Promise<Address[]>;
  send: (request: OutboundRequest, address: Address, signal: AbortSignal) => Promise<OutboundResponse>;
};

/** No DNS or connection occurs until approval of the exact frozen request. */
export async function brokerRequest(
  request: OutboundRequest,
  authorize: (request: OutboundRequest) => Promise<boolean>,
  signal: AbortSignal,
  dependencies: NetworkDependencies = { resolve: (host) => lookup(host, { all: true }), send: sendPinned },
  options: { allowPrivate?: boolean } = {},
): Promise<OutboundResponse> {
  signal.throwIfAborted();
  if (!await authorize(request)) throw new Error("Internet access denied by LegalWork permissions.");
  signal.throwIfAborted();
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await dependencies.resolve(hostname);
  signal.throwIfAborted();
  if (!addresses.length || (!options.allowPrivate && addresses.some(({ address }) => !publicAddress(address)))) {
    throw new Error("The destination resolves to a local, private or reserved address.");
  }
  // The validated IP is dialled directly. TLS still verifies the original host.
  return dependencies.send(request, addresses[0], signal);
}

function sendPinned(input: OutboundRequest, address: Address, signal: AbortSignal): Promise<OutboundResponse> {
  const url = new URL(input.url);
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send({
      hostname: address.address,
      servername: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      method: input.method, path: url.pathname + url.search,
      headers: input.headers, agent: false, signal,
    }, (res) => {
      const parts: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) res.destroy(new Error("Sandbox response is too large."));
        else parts.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined && !hopHeaders.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({ status: res.statusCode ?? 502, headers, bodyBase64: Buffer.concat(parts).toString("base64") });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Sandbox HTTP request timed out.")));
    req.on("error", reject);
    req.end(Buffer.from(input.bodyBase64, "base64"));
  });
}
