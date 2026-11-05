import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync, deflateSync, deflateRawSync } from "node:zlib";
import { prepareRawHttpRequest, rawHttpRequest, type RawHttpNetwork, type RawHttpRequest } from "./raw-http.js";

const signal = () => new AbortController().signal;
const input = { url: "https://example.com/upload", method: "POST", headers: { "content-type": "application/octet-stream", authorization: "private", cookie: "private=1" }, bodyBase64: "AAH/" };
const success = { status: 200, statusText: "OK", headers: {}, bodyBase64: "AAH/" };

test("authorization precedes DNS and every connection, including cancellation while resolving", async () => {
  let resolved = 0, sent = 0;
  const network: RawHttpNetwork = { resolve: async () => { resolved++; return [{ address: "93.184.216.34", family: 4 }]; }, send: async () => { sent++; return success; } };
  await expect(rawHttpRequest(input, async () => false, signal(), { allowPrivate: false, network })).rejects.toThrow("denied");
  expect({ resolved, sent }).toEqual({ resolved: 0, sent: 0 });
  const controller = new AbortController();
  let resolving: () => void = () => {};
  const started = new Promise<void>(resolve => { resolving = resolve; });
  const result = rawHttpRequest(input, async () => true, controller.signal, { allowPrivate: false,
    network: { ...network, resolve: async () => { resolving(); return new Promise(() => {}); } } });
  await started;
  controller.abort(new Error("Stop during DNS"));
  await expect(result).rejects.toThrow("Stop during DNS");
  expect(sent).toBe(0);
});

test("DNS results are pinned, mixed public/private answers never connect", async () => {
  let sent = 0;
  const network: RawHttpNetwork = { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    send: async () => { sent++; return success; } };
  await expect(rawHttpRequest(input, async () => true, signal(), { allowPrivate: false, network })).rejects.toThrow("private");
  expect(sent).toBe(0);
  const received = await rawHttpRequest(input, async () => true, signal(), { allowPrivate: false, network: { ...network,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }], send: async (_, address) => { expect(address).toEqual({ address: "93.184.216.34", family: 4 }); return success; } } });
  expect(received).toMatchObject({ ...success, url: input.url, redirected: false });
});

test("the inherited 30s transport budget spans redirects and excludes every approval wait", async () => {
  let now = 0, sent = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const network: RawHttpNetwork = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], send: async () => {
    sent++; now += 16000;
    return sent === 1 ? { ...success, status: 307, headers: { location: "/second" } } : success;
  } };
  try {
    await expect(rawHttpRequest(input, async () => { now += 100000; return true; }, signal(), { allowPrivate: false, network })).rejects.toThrow("timed out");
    expect(sent).toBe(2); // A new per-hop deadline would incorrectly succeed.
    now = 0;
    const result = await rawHttpRequest(input, async () => { now += 100000; return true; }, signal(), { allowPrivate: false,
      network: { ...network, send: async () => { now += 29000; return success; } } });
    expect(result.status).toBe(200); // Approval's 100s must not consume the 30s.
  } finally { clock.mockRestore(); }
});

test.each([301, 302, 303, 307, 308])("redirect %s is separately approved with Fetch body and credential semantics", async status => {
  const approved: RawHttpRequest[] = [], sent: RawHttpRequest[] = [];
  const result = await rawHttpRequest(input, async request => { approved.push(request); return true; }, signal(), { allowPrivate: false,
    network: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], send: async request => {
      sent.push(request);
      return sent.length === 1 ? { ...success, status, headers: { location: "https://other.example/final" } } : { ...success, status: 418, statusText: "I'm a teapot" };
    } } });
  expect(approved).toEqual(sent);
  expect(approved).toHaveLength(2);
  const next = approved[1];
  expect(next.headers.authorization).toBeUndefined(); expect(next.headers.cookie).toBeUndefined();
  expect(next.method).toBe(status === 307 || status === 308 ? "POST" : "GET");
  expect(next.bodyPresent).toBe(status === 307 || status === 308);
  expect(next.bodyBase64).toBe(status === 307 || status === 308 ? input.bodyBase64 : "");
  if (status === 307 || status === 308) expect(next.headers["content-type"]).toBe(input.headers["content-type"]);
  else expect(next.headers["content-type"]).toBeUndefined();
  expect(result).toMatchObject({ url: "https://other.example/final", redirected: true, status: 418, statusText: "I'm a teapot" });
});

test("same-origin redirects preserve credentials; consent cannot authorize a changed body or target", async () => {
  const approved: RawHttpRequest[] = [];
  let sent = 0;
  await expect(rawHttpRequest(input, async request => { approved.push(request); return approved.length === 1; }, signal(), { allowPrivate: false,
    network: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], send: async () => { sent++; return { ...success, status: 307, headers: { location: "/second" } }; } } })).rejects.toThrow("denied");
  expect(sent).toBe(1);
  expect(approved[1].headers.authorization).toBe("private");
  expect(approved[1].sha256).not.toBe(approved[0].sha256);
  expect(Object.isFrozen(approved[0])).toBe(true); expect(Object.isFrozen(approved[0].headers)).toBe(true);
});

test("Request validation preserves no-body, empty-body, methods and complete headers", () => {
  expect(prepareRawHttpRequest({ url: input.url, method: "GET", headers: {} }).bodyPresent).toBe(false);
  expect(prepareRawHttpRequest({ url: input.url, method: "GET", headers: {}, bodyBase64: "" }).bodyBytes).toBe(0);
  expect(() => prepareRawHttpRequest({ url: input.url, method: "GET", headers: {}, bodyBase64: "AA==" })).toThrow();
  expect(prepareRawHttpRequest({ ...input, bodyBase64: "" })).toMatchObject({ bodyPresent: true, bodyBytes: 0 });
  expect(prepareRawHttpRequest({ ...input, method: "A".repeat(40) }).method).toHaveLength(40);
  const headers = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`x-${index}`, "value"]));
  expect(Object.keys(prepareRawHttpRequest({ ...input, headers: { ...headers, "x-long": "y".repeat(9000) } }).headers)).toHaveLength(151);
  expect(() => prepareRawHttpRequest({ ...input, method: "TRACE" })).toThrow();
  expect(() => prepareRawHttpRequest({ ...input, headers: { "content-length": "1" } })).toThrow("Content-Length");
  expect(() => prepareRawHttpRequest({ ...input, bodyBase64: "bad" })).toThrow("encoding");
});

test("real transport preserves binary bodies beyond both page-broker ceilings and full response status/headers", async () => {
  const requestBytes = Buffer.alloc(5 * 1024 * 1024 + 37, 0xff);
  const responseBytes = Buffer.alloc(17 * 1024 * 1024 + 43, 0xc5);
  let observed = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    observed = createHash("sha256").update(await request.bytes()).digest("hex");
    expect(request.headers.get("x-long")).toHaveLength(9000);
    return new Response(responseBytes, { status: 422, statusText: "Complete body", headers: { "x-long": "v".repeat(9000) } });
  } });
  try {
    const response = await rawHttpRequest({ url: server.url.href, method: "POST", headers: { "x-long": "q".repeat(9000) }, bodyBase64: requestBytes.toString("base64") }, async () => true, signal(), { allowPrivate: true });
    expect(observed).toBe(createHash("sha256").update(requestBytes).digest("hex"));
    expect(response).toMatchObject({ status: 422, statusText: "Unprocessable Entity", url: server.url.href, redirected: false });
    expect(response.headers["x-long"]).toHaveLength(9000);
    expect(Buffer.from(response.bodyBase64, "base64").equals(responseBytes)).toBe(true);
  } finally { await server.stop(true); }
});

test.each(["gzip", "br", "deflate", "raw-deflate"])("real transport returns complete decoded %s response bytes like Fetch", async encoding => {
  const original = Buffer.from("complete decoded body\n".repeat(60000));
  const compressed = encoding === "gzip" ? gzipSync(original) : encoding === "br" ? brotliCompressSync(original) : encoding === "deflate" ? deflateSync(original) : deflateRawSync(original);
  const header = encoding === "raw-deflate" ? "deflate" : encoding;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(compressed, { headers: { "content-encoding": header } }) });
  try {
    const response = await rawHttpRequest({ url: server.url.href, method: "GET", headers: {} }, async () => true, signal(), { allowPrivate: true });
    expect(response.headers["content-encoding"]).toBe(header);
    expect(Buffer.from(response.bodyBase64, "base64").equals(original)).toBe(true);
  } finally { await server.stop(true); }
});

test("Stop aborts a real response body instead of returning partial successful bytes", async () => {
  let started: () => void = () => {};
  const responseStarted = new Promise<void>(resolve => { started = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); started(); } })) });
  const controller = new AbortController();
  try {
    const result = rawHttpRequest({ url: server.url.href, method: "GET", headers: {} }, async () => true, controller.signal, { allowPrivate: true });
    await responseStarted;
    controller.abort(new Error("User stopped"));
    await expect(result).rejects.toThrow("User stopped");
  } finally { await server.stop(true); }
});

test("a real redirect cancels its discarded body without an unhandled transport error", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    return path === "/first" ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), { status: 307, headers: { location: "/last" } }) : new Response("complete");
  } });
  try {
    const response = await rawHttpRequest({ url: new URL("/first", server.url).href, method: "GET", headers: {} }, async () => true, signal(), { allowPrivate: true });
    expect(response.redirected).toBe(true); expect(Buffer.from(response.bodyBase64, "base64").toString()).toBe("complete"); expect(paths).toEqual(["/first", "/last"]);
  } finally { await server.stop(true); }
});
