import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { rawHttpProxy } from "./raw-http-proxy.js";
import { rawHttpOutputSchema, type RawHttpInput } from "./raw-http-schema.js";

test("proxy environment matches native Bun NO_PROXY precedence/domain/IP/CIDR/port behavior", () => {
  const environment = { HTTP_PROXY: "http://upper.example", http_proxy: "http://lower.example", HTTPS_PROXY: "https://secure.example", ALL_PROXY: "http://all.example" };
  expect(rawHttpProxy(new URL("http://service.example"), environment)?.hostname).toBe("lower.example");
  expect(rawHttpProxy(new URL("https://service.example"), environment)?.hostname).toBe("secure.example");
  expect(rawHttpProxy(new URL("http://service.example"), { ALL_PROXY: environment.ALL_PROXY })?.hostname).toBe("all.example");
  for (const no_proxy of ["service.example", ".service.example", "*.service.example", "*"]) {
    expect(rawHttpProxy(new URL("http://sub.service.example"), { ...environment, no_proxy })).toBeUndefined();
    expect(rawHttpProxy(new URL("http://service.example"), { ...environment, no_proxy })).toBeUndefined();
  }
  expect(rawHttpProxy(new URL("http://notservice.example"), { ...environment, NO_PROXY: "service.example" })?.hostname).toBe("lower.example");
  expect(rawHttpProxy(new URL("https://service.example"), { ALL_PROXY: environment.ALL_PROXY })?.hostname).toBe("all.example");
  expect(rawHttpProxy(new URL("http://service.example"), { ...environment, NO_PROXY: "*", no_proxy: "unrelated.example" })?.hostname).toBe("lower.example");
  for (const [url, no_proxy] of [["http://127.0.0.1", "127.0.0.0/8"], ["http://[::1]", "[::1]"], ["http://[::1]", "::1/128"], ["https://service.example", "service.example:443"]]) expect(rawHttpProxy(new URL(url), { ...environment, NO_PROXY: no_proxy })).toBeUndefined();
  expect(rawHttpProxy(new URL("http://service.example"), { ...environment, NO_PROXY: "service.example:443" })?.hostname).toBe("lower.example");
  expect(() => rawHttpProxy(new URL("http://service.example"), { HTTP_PROXY: "socks5://unsupported.example" })).toThrow("no direct connection");
});

const outcomeSchema = z.union([z.object({ ok: z.literal(true), result: rawHttpOutputSchema }), z.object({ ok: z.literal(false), error: z.string() })]);

const node = resolve(import.meta.dir, "../../../desktop/resources/node", process.platform === "win32" ? "node.exe" : "node");
// Each runtime owns its fixture and original 30s test budget; cold starts from
// other runtimes must not consume this mode's TLS/Stop assertion time.
for (const mode of [{ name: "Node22", binary: node, worker: false }, { name: "Bun", binary: process.execPath, worker: false },
  ...(process.platform === "win32" ? [] : [{ name: "Node22 worker", binary: node, worker: true }])])
test(`${mode.name} uses pinned proxy targets, enterprise CA, NO_PROXY and Stop without direct fallback`, async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raw-http-proxy-"));
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const originRequests: Array<{ target: string; host?: string; authenticated: boolean }> = [];
  const proxyRequests: Array<{ target: string; host?: string; authenticated: boolean }> = [];
  const connections: string[] = [];
  const wire: string[] = [];
  let connectionReady: (() => void) | undefined;
  let bodyReady: (() => void) | undefined;
  let holdTunnel = false;
  let rejectTunnel = false;
  const certPath = join(root, "fixture-ca.pem"), keyPath = join(root, "fixture-key.pem"), proxyCertPath = join(root, "proxy-ca.pem"), proxyKeyPath = join(root, "proxy-key.pem"), bundlePath = join(root, "native-extra-roots.pem");
  for (const [cert, key] of [[certPath, keyPath], [proxyCertPath, proxyKeyPath]]) {
    const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
    expect(generated.exitCode).toBe(0);
  }
  // Test-only startup configuration: the runtime parses all public certificate
  // blocks. Production transport never opens this file or parses X509 itself.
  await writeFile(bundlePath, Buffer.concat([await readFile(certPath), await readFile(proxyCertPath)]));
  const tls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  const proxyTls = { cert: await readFile(proxyCertPath), key: await readFile(proxyKeyPath) };
  const origin = createServer((request, response) => { originRequests.push({ target: request.url ?? "", host: request.headers.host, authenticated: request.headers.authorization === "origin-secret" }); response.end("origin-positive"); });
  const ipv4Only = createServer((_request, response) => response.end("validated-address-fallback"));
  const secure = createHttpsServer(tls, (request, response) => {
    originRequests.push({ target: request.url ?? "", host: request.headers.host, authenticated: request.headers.authorization === "origin-secret" });
    response.writeHead(200); response.write("secure-positive");
    if (request.url === "/wait") bodyReady?.();
    if (request.url !== "/wait") response.end();
  });
  const forwardProxy = (request: IncomingMessage, response: ServerResponse) => {
    proxyRequests.push({ target: request.url ?? "", host: request.headers.host, authenticated: request.headers["proxy-authorization"] === "Basic Zml4dHVyZTpwcm94eQ==" });
    response.writeHead(200, "Proxy custom status"); response.end("proxy-positive");
  };
  const proxy = createServer(forwardProxy), secureProxy = createHttpsServer(proxyTls, forwardProxy);
  const tunnel = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    connections.push(request.url ?? ""); connectionReady?.();
    if (holdTunnel) return;
    if (rejectTunnel) { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
    const target = new URL(`http://${request.url}`);
    const destination = connect(Number(target.port), target.hostname.replace(/^\[|\]$/g, ""), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) destination.write(head);
      destination.pipe(socket); socket.pipe(destination);
    });
    track(destination); socket.once("close", () => destination.destroy()); destination.once("error", () => socket.destroy());
  };
  proxy.on("connect", tunnel); secureProxy.on("connect", tunnel);
  const raw = createTcpServer(socket => {
    track(socket);
    socket.once("data", chunk => {
      wire.push(chunk.toString().split("\r\n")[0]);
      const headers = Array.from({ length: 2200 }, (_, index) => `x-field-${index}: full`).join("\r\n");
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 Custom complete reason\r\nContent-Length: 3\r\n${headers}\r\nx-repeat: one\r\nx-repeat: two\r\n\r\n`), Buffer.from([0, 1, 255])]));
    });
  });
  for (const server of [origin, secure, proxy, secureProxy, ipv4Only]) server.on("connection", track);
  const port = async (server: typeof origin | typeof secure) => { await new Promise<void>(done => server.listen(0, done)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); return address.port; };
  const [originPort, securePort, proxyPort, secureProxyPort] = await Promise.all([port(origin), port(secure), port(proxy), port(secureProxy)]);
  await new Promise<void>(resolve => ipv4Only.listen(0, "127.0.0.1", resolve));
  const ipv4Address = ipv4Only.address(); if (!ipv4Address || typeof ipv4Address === "string") throw new Error("No IPv4 fixture port");
  await new Promise<void>(resolve => raw.listen(0, resolve)); const rawAddress = raw.address(); if (!rawAddress || typeof rawAddress === "string") throw new Error("No raw fixture port");
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "raw-http.test-driver.ts")], outdir: root, target: "node", format: "esm", naming: "driver.mjs" });
  expect(built.success).toBe(true);
  const fixtureProxyURL = (protocol: string, port: number) => {
    const url = new URL(`${protocol}://localhost:${port}`);
    url.username = "fixture"; url.password = "proxy";
    return url.href;
  };
  const environment = { ...process.env, HTTP_PROXY: fixtureProxyURL("http", proxyPort), HTTPS_PROXY: fixtureProxyURL("http", proxyPort),
    http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "", NO_PROXY: "", no_proxy: "", NODE_EXTRA_CA_CERTS: bundlePath, SSL_CERT_FILE: "", SSL_CERT_DIR: "", NODE_USE_SYSTEM_CA: "" };
  const run = async (binary: string, input: RawHttpInput, options: { trusted?: boolean; extraCaFile?: string; verificationDisabled?: boolean; noProxy?: string; stop?: Promise<void>; secureProxy?: boolean; worker?: boolean } = {}) => {
    // The wrapper is TEST-ONLY startup trust for the controlled origin/proxy.
    // Production child environment still removes all certificate override files;
    // actual OS-store trust is tested in the installed Windows acceptance run.
    const extraRoot = options.trusted === false ? "" : options.extraCaFile ?? bundlePath;
    const wrapper = join(root, `node-worker-${crypto.randomUUID()}`);
    if (options.worker) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(wrapper, `#!/bin/sh\nNODE_EXTRA_CA_CERTS=${quote(extraRoot)} exec ${quote(node)} "$@"\n`);
      await chmod(wrapper, 0o700);
    }
    return new Promise<z.infer<typeof outcomeSchema>>((done, reject) => {
    const child = spawn(binary, [join(root, "driver.mjs"), JSON.stringify(input), ...(options.worker ? [wrapper] : [])], { env: { ...environment, ...(options.secureProxy ? { HTTP_PROXY: fixtureProxyURL("https", secureProxyPort), HTTPS_PROXY: fixtureProxyURL("https", secureProxyPort) } : {}), NODE_EXTRA_CA_CERTS: options.trusted === false ? "" : options.extraCaFile ?? bundlePath, NODE_TLS_REJECT_UNAUTHORIZED: options.verificationDisabled ? "0" : "1", NO_PROXY: options.noProxy ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { errors += String(chunk); });
    child.once("error", reject); child.once("exit", code => { try { if (code !== 0) throw new Error(`Fixture exit ${code}: ${errors}`); done(outcomeSchema.parse(JSON.parse(output))); } catch (error) { reject(error); } });
    if (options.stop) void options.stop.then(() => child.stdin.write("Stop"));
    });
  };
  try {
    const binary = mode.binary;
    const execute = (input: RawHttpInput, options: Parameters<typeof run>[2] = {}) => run(binary, input, { ...options, worker: mode.worker });
    originRequests.length = 0; proxyRequests.length = 0;
    const proxied = await execute({ url: `http://localhost:${originPort}/path`, method: "GET", headers: {} });
    expect(proxied.ok && Buffer.from(proxied.result.bodyBase64, "base64").toString()).toBe("proxy-positive");
    expect(originRequests).toHaveLength(0); expect(proxyRequests).toHaveLength(1);
    expect(proxyRequests[0].target).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):/); expect(proxyRequests[0].host).toBe(`localhost:${originPort}`); expect(proxyRequests[0].authenticated).toBe(true);
    if (proxied.ok) expect(proxied.result.statusText).toBe("Proxy custom status");
    const tlsForwarded = await execute({ url: `http://localhost:${originPort}/tls-proxy-forward`, method: "GET", headers: {} }, { secureProxy: true });
    expect(tlsForwarded.ok && Buffer.from(tlsForwarded.result.bodyBase64, "base64").toString()).toBe("proxy-positive");
    expect(originRequests).toHaveLength(0); expect(proxyRequests).toHaveLength(2);
    const bypassed = await execute({ url: `http://localhost:${originPort}/path`, method: "GET", headers: {} }, { noProxy: "localhost" });
    expect(bypassed.ok && Buffer.from(bypassed.result.bodyBase64, "base64").toString()).toBe("origin-positive");
    // The driver resolves ::1 first; only the prevalidated second IPv4 address accepts connections.
    const fallback = await execute({ url: `http://localhost:${ipv4Address.port}/fallback`, method: "GET", headers: {} }, { noProxy: "*" });
    expect(fallback.ok && Buffer.from(fallback.result.bodyBase64, "base64").toString()).toBe("validated-address-fallback");
    const secureInput = { url: `https://localhost:${securePort}/path`, method: "GET", headers: { authorization: "origin-secret" } };
    const accepted = await execute(secureInput);
    expect(accepted.ok && Buffer.from(accepted.result.bodyBase64, "base64").toString()).toBe("secure-positive");
    expect(connections.at(-1)).toMatch(/^(127\.0\.0\.1|\[::1\]):/); expect(originRequests.at(-1)?.authenticated).toBe(true);
    const secureTunnel = await execute(secureInput, { secureProxy: true });
    expect(secureTunnel.ok && Buffer.from(secureTunnel.result.bodyBase64, "base64").toString()).toBe("secure-positive");
    // Both independent origin/proxy roots in the native startup bundle are
    // necessary; supplying only one never broadens the other connection.
    expect((await execute(secureInput, { extraCaFile: certPath, secureProxy: true })).ok).toBe(false);
    expect((await execute(secureInput, { extraCaFile: proxyCertPath, noProxy: "*" })).ok).toBe(false);
    expect((await execute(secureInput, { extraCaFile: keyPath, noProxy: "*" })).ok).toBe(false);
    const untrusted = await execute(secureInput, { trusted: false }); expect(untrusted.ok).toBe(false);
    // Explicit verification defeats an inherited disable-verification switch
    // on direct origin TLS, proxy CONNECT and TLS to the proxy itself.
    for (const options of [{ noProxy: "*" }, {}, { secureProxy: true }])
      expect((await execute(secureInput, { ...options, trusted: false, verificationDisabled: true })).ok).toBe(false);
    expect((await execute({ url: `http://localhost:${originPort}/untrusted-tls-proxy`, method: "GET", headers: {} }, { secureProxy: true, trusted: false, verificationDisabled: true })).ok).toBe(false);
    rejectTunnel = true;
    const denied = await execute(secureInput); expect(denied.ok).toBe(false);
    rejectTunnel = false;
    const ready = new Promise<void>(resolve => { bodyReady = resolve; });
    const cancelled = await execute({ ...secureInput, url: `https://localhost:${securePort}/wait` }, { stop: ready });
    expect(cancelled.ok).toBe(false); if (!cancelled.ok) expect(cancelled.error).toContain("Fixture Stop");
    bodyReady = undefined;
    holdTunnel = true;
    const tunnelReady = new Promise<void>(resolve => { connectionReady = resolve; });
    const cancelledTunnel = await execute(secureInput, { stop: tunnelReady });
    expect(cancelledTunnel.ok).toBe(false); if (!cancelledTunnel.ok) expect(cancelledTunnel.error).toContain("Fixture Stop");
    holdTunnel = false;
    connectionReady = undefined;
    const custom = await execute({ url: `http://localhost:${rawAddress.port}/wire`, method: "A".repeat(80), headers: {} }, { noProxy: "*" });
    expect(wire.at(-1)).toBe(`${"A".repeat(80)} /wire HTTP/1.1`);
    expect(custom.ok).toBe(true);
    if (custom.ok) { expect(custom.result.statusText).toBe("Custom complete reason"); expect(Object.keys(custom.result.headers).length).toBe(2202); expect(custom.result.headers["x-repeat"]).toBe("one, two"); expect(custom.result.bodyBase64).toBe("AAH/"); }
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, secure, proxy, secureProxy, raw, ipv4Only].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
