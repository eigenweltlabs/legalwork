import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createNodeRawHttpTransport, rawHttpNodeEnvironment } from "./raw-http-node.js";
import { RAW_HTTP_NODE_CODE } from "./raw-http-node-code.js";
import { rawHttpNodeReply } from "./raw-http-node-contract.js";
import { prepareRawHttpRequest, rawHttpRequest, type Address, type RawHttpRequest } from "./raw-http.js";

const transports: ReturnType<typeof createNodeRawHttpTransport>[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.close())); });
const createSend = (executable: () => string) => { const transport = createNodeRawHttpTransport(executable); transports.push(transport); return transport.send; };
const node = resolve(import.meta.dir, "../../../desktop/resources/node", process.platform === "win32" ? "node.exe" : "node");
const loopback: Address = { address: "127.0.0.1", family: 4 };
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const closed = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
  child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
});
const port = async (server: Server) => {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const bound = server.address(); if (!bound || typeof bound === "string") throw new Error("Fixture port unavailable");
  return bound.port;
};
function privateWorker() {
  const child = spawn(node, ["-"], { env: rawHttpNodeEnvironment(process.env), stdio: ["pipe", "ignore", "pipe", "ipc"], serialization: "json" });
  const end = closed(child), errors: Buffer[] = [];
  child.stderr?.on("data", value => errors.push(Buffer.from(value)));
  const ready = new Promise<void>((done, reject) => {
    child.once("message", value => {
      const reply = rawHttpNodeReply.parse(value);
      if (reply.kind !== "ready" || reply.pid !== child.pid) { reject(new Error("Missing genuine worker handshake")); return; }
      done();
    });
    child.once("error", reject);
  });
  child.stdin?.end(RAW_HTTP_NODE_CODE);
  return { child, ready, end, errors };
}
function sendRequest(child: ChildProcess, request: RawHttpRequest) {
  child.send?.({ kind: "request", id: "00000000-0000-0000-0000-000000000000:1", request, address: loopback, addresses: [loopback], proxy: {} });
}

test("worker environment preserves OS identity/proxies but excludes credentials, preload and certificate overrides", () => {
  expect(rawHttpNodeEnvironment({ SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture", HOME: "/Users/fixture", PATH: "/bin", https_proxy: "http://proxy", NO_PROXY: "localhost", NODE_OPTIONS: "--require inject", NODE_PATH: "/inject", NODE_EXTRA_CA_CERTS: "/extra", SSL_CERT_FILE: "/ca", SSL_CERT_DIR: "/roots", NODE_TLS_REJECT_UNAUTHORIZED: "0", OPENAI_API_KEY: "provider", LEGALWORK_SERVER_TOKEN: "server" }))
    .toEqual({ SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture", HOME: "/Users/fixture", PATH: "/bin", https_proxy: "http://proxy", NO_PROXY: "localhost" });
});

test("real Node hop preserves pinned host, full >17MiB binary upload/download and decoded compression", async () => {
  const bytes = Buffer.alloc(17 * 1024 * 1024 + 37); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  let upload: Buffer | undefined, host: string | undefined;
  const server = createServer(async (request, response) => {
    host = request.headers.host;
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part)); upload = Buffer.concat(parts);
    response.writeHead(218, "Complete custom status", { "x-full-result": "yes", ...(request.url === "/gzip" ? { "content-encoding": "gzip" } : {}) });
    response.end(request.url === "/gzip" ? gzipSync(bytes) : bytes);
  });
  const target = await port(server), send = createSend(() => node);
  try {
    const response = await send(prepareRawHttpRequest({ url: `http://never-resolve.invalid:${target}/binary`, method: "POST", headers: {}, bodyBase64: bytes.toString("base64") }), loopback, new AbortController().signal);
    expect(host).toBe(`never-resolve.invalid:${target}`); expect(upload && digest(upload)).toBe(digest(bytes));
    expect(response.status).toBe(218); expect(response.statusText).toBe("Complete custom status"); expect(response.headers["x-full-result"]).toBe("yes");
    expect(digest(Buffer.from(response.bodyBase64, "base64"))).toBe(digest(bytes));
    const decoded = await send(prepareRawHttpRequest({ url: `http://never-resolve.invalid:${target}/gzip`, method: "GET", headers: {} }), loopback, new AbortController().signal);
    expect(decoded.headers["content-encoding"]).toBe("gzip"); expect(digest(Buffer.from(decoded.bodyBase64, "base64"))).toBe(digest(bytes));
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 30000);

test("parent authorizes each redirect before DNS/worker and retains cross-origin credential stripping", async () => {
  const seen: Array<{ url?: string; authorization?: string; cookie?: string }> = [], consent: string[] = [], lookups: string[] = [];
  let target = 0;
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (request.url === "/start") { response.writeHead(302, { location: `http://second.invalid:${target}/end` }); response.end(); }
    else response.end("complete");
  });
  target = await port(server);
  const send = createSend(() => node);
  const input = { url: `http://first.invalid:${target}/start`, method: "POST", headers: { authorization: "owned-fixture", cookie: "fixture=yes", "content-type": "text/plain" }, bodyBase64: Buffer.from("owned").toString("base64") };
  const options = { allowPrivate: true, network: { resolve: async (host: string) => { lookups.push(host); return [loopback]; }, send } };
  try {
    await expect(rawHttpRequest(input, async request => { consent.push(request.url); return consent.length === 1; }, new AbortController().signal, options)).rejects.toThrow("denied");
    expect(seen).toHaveLength(1); expect(lookups).toEqual(["first.invalid"]); expect(consent).toHaveLength(2);
    seen.length = 0;
    const result = await rawHttpRequest(input, async () => true, new AbortController().signal, options);
    expect(Buffer.from(result.bodyBase64, "base64").toString()).toBe("complete"); expect(result.redirected).toBe(true);
    expect(seen).toEqual([{ url: "/start", authorization: "owned-fixture", cookie: "fixture=yes" }, { url: "/end", authorization: undefined, cookie: undefined }]);
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test("Stop closes only its held HTTP body before settling; pre-abort never selects an executable", async () => {
  let opened: (() => void) | undefined, peerClosed: (() => void) | undefined;
  const body = new Promise<void>(done => { opened = done; }), disconnected = new Promise<void>(done => { peerClosed = done; });
  const server = createServer((request, response) => { request.socket.once("close", () => peerClosed?.()); response.writeHead(200); response.write("partial"); opened?.(); });
  const target = await port(server), controller = new AbortController();
  let executableReads = 0;
  const send = createSend(() => { executableReads++; return node; });
  try {
    const outcome = send(prepareRawHttpRequest({ url: `http://localhost:${target}/hold`, method: "GET", headers: {} }), loopback, controller.signal).then(() => "unexpected", error => error);
    await body; controller.abort(new Error("Owned Stop control"));
    const result = await outcome; await disconnected;
    expect(result).toBeInstanceOf(Error); expect(result.message).toBe("Owned Stop control"); expect(executableReads).toBe(1);
    const already = new AbortController(); already.abort(new Error("Before spawn"));
    expect(() => send(prepareRawHttpRequest({ url: `http://localhost:${target}/unused`, method: "GET", headers: {} }), loopback, already.signal)).toThrow("Before spawn");
    expect(executableReads).toBe(1);
    const selected = new AbortController();
    const interruptedSelection = createSend(() => { selected.abort(new Error("Aborted during selection")); return "/must-never-spawn"; });
    await expect(interruptedSelection(prepareRawHttpRequest({ url: `http://localhost:${target}/unused`, method: "GET", headers: {} }), loopback, selected.signal)).rejects.toThrow("Aborted during selection");
  } finally { controller.abort(); await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test("private worker rejects malformed/duplicate requests and exits when its parent disconnects", async () => {
  let opened: (() => void) | undefined, peerClosed: (() => void) | undefined;
  const active = new Promise<void>(done => { opened = done; }), disconnected = new Promise<void>(done => { peerClosed = done; });
  const server = createServer((request, response) => { request.socket.once("close", () => peerClosed?.()); response.writeHead(200); response.write("pending"); opened?.(); });
  const target = await port(server);
  try {
    const idle = privateWorker(); await idle.ready; idle.child.disconnect(); expect((await idle.end).code).toBe(1);
    const malformed = privateWorker(); await malformed.ready; malformed.child.send?.({ kind: "request", executable: "/not-allowed" });
    expect((await malformed.end).code).toBe(1); expect(Buffer.concat(malformed.errors).toString()).toContain("Invalid private HTTP worker request");
    const duplicate = privateWorker(); await duplicate.ready;
    const request = prepareRawHttpRequest({ url: `http://localhost:${target}/hold`, method: "GET", headers: {} });
    sendRequest(duplicate.child, request); await active; sendRequest(duplicate.child, request);
    expect((await duplicate.end).code).toBe(1); expect(Buffer.concat(duplicate.errors).toString()).toContain("Duplicate"); await disconnected;
    let secondOpened: (() => void) | undefined;
    const second = new Promise<void>(done => { secondOpened = done; }); server.once("request", () => secondOpened?.());
    const orphan = privateWorker(); await orphan.ready; sendRequest(orphan.child, request); await second; orphan.child.disconnect();
    expect((await orphan.end).code).toBe(1);
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test("untrusted HTTPS is rejected before any application request with full private TLS error", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hop-untrusted-"));
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  expect(generated.exitCode).toBe(0);
  let requests = 0;
  const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => { requests++; response.end("must not be read"); });
  const target = await port(server);
  try {
    const error = await createSend(() => node)(prepareRawHttpRequest({ url: `https://localhost:${target}/`, method: "GET", headers: {} }), loopback, new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT"); expect(error.workerDetails).toContain("self-signed certificate"); expect(requests).toBe(0);
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 15000);

test.skipIf(process.platform === "win32")("parent rejects early/malformed/duplicate/dead worker responses without fallback, retaining complete stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hop-protocol-"));
  const request = prepareRawHttpRequest({ url: "http://unused.invalid", method: "GET", headers: {} });
  try {
    for (const scenario of ["early", "malformed", "duplicate", "death"]) {
      const script = join(root, `${scenario}.cjs`), executable = join(root, scenario);
      const ready = "process.send({kind:'ready',pid:process.pid,node:process.versions.node,openssl:process.versions.openssl,rss:process.memoryUsage().rss});";
      const outcome = "{kind:'result',result:{status:200,statusText:'OK',headers:{},bodyBase64:''}}";
      const result = `{kind:'settled',id:'00000000-0000-0000-0000-000000000000:1',outcome:${outcome}}`;
      const source = scenario === "early" ? `process.send(${result});` : scenario === "malformed" ? "process.send({kind:'ready',unexpected:true});" : scenario === "death" ? "process.exit(7);" : `${ready} process.once('message',m=>{const reply={kind:'settled',id:m.id,outcome:${outcome}};process.send(reply);process.send(reply);});`;
      await writeFile(script, `process.stdin.resume();process.stderr.write('owned-complete-diagnostic-${scenario}');${source}`);
      await writeFile(executable, `#!/bin/sh\nexec '${node.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`); await chmod(executable, 0o700);
      let factories = 0;
      const error = await createSend(() => { factories++; return executable; })(request, loopback, new AbortController().signal).catch(error => error);
      expect(factories).toBe(1);
      expect(error).toBeInstanceOf(Error); expect(error.workerStderr).toContain(`owned-complete-diagnostic-${scenario}`);
      if (scenario === "death") {
        expect(error.workerExitCode).toBe(7); expect(error.workerSignal).toBeNull();
        // A child that exits before stdin finishes can also report EPIPE.
        // Retain that genuine primary error and independently prove its exit.
        if (error.code === "EPIPE") { expect(error.message).toContain("broken pipe"); expect(error.syscall).toBe("write"); }
        else expect(error.message).toBe("HTTP worker exited before cleanup (code 7, signal null).");
      } else expect(error.message).toContain(scenario === "early" ? "ready handshake" : scenario === "malformed" ? "Invalid private" : "duplicate");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

test("actual Node parent death disconnects and terminates its active transport child", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hop-parent-death-"));
  let opened: (() => void) | undefined, peerClosed: (() => void) | undefined;
  let openedCount = 0, closedCount = 0;
  const active = new Promise<void>(done => { opened = done; }), disconnected = new Promise<void>(done => { peerClosed = done; });
  const server = createServer((request, response) => { request.socket.once("close", () => { if (++closedCount === 2) peerClosed?.(); }); response.writeHead(200); response.write("pending"); if (++openedCount === 2) opened?.(); });
  const target = await port(server);
  const request = prepareRawHttpRequest({ url: `http://localhost:${target}/parent-death`, method: "GET", headers: {} });
  const script = join(root, "parent.cjs");
  await writeFile(script, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-'],{env:${JSON.stringify(rawHttpNodeEnvironment(process.env))},stdio:['pipe','ignore','ignore','ipc']});child.on('message',m=>{if(m.kind==='ready'){process.send({child:child.pid});child.send(${JSON.stringify({ kind: "request", id: "00000000-0000-0000-0000-000000000000:1", request, address: loopback, addresses: [loopback], proxy: {} })});child.send(${JSON.stringify({ kind: "request", id: "00000000-0000-0000-0000-000000000000:2", request, address: loopback, addresses: [loopback], proxy: {} })});}});child.stdin.end(${JSON.stringify(RAW_HTTP_NODE_CODE)});`);
  const parent = spawn(node, [script], { stdio: ["ignore", "ignore", "pipe", "ipc"] }), parentEnd = closed(parent);
  const workerPID = new Promise<number>((done, reject) => { parent.once("message", value => {
    if (value && typeof value === "object" && "child" in value && typeof value.child === "number") done(value.child); else reject(new Error("Missing child identity"));
  }); parent.once("error", reject); });
  try {
    const pid = await workerPID; await active;
    expect(parent.kill("SIGKILL")).toBe(true); expect((await parentEnd).signal).toBe("SIGKILL"); await disconnected;
    // This is only a diagnostic liveness poll of the exact owned child, never a signal.
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt++) {
      try { process.kill(pid, 0); await Bun.sleep(5); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false; else throw error; }
    }
    expect(alive).toBe(false); expect(openedCount).toBe(2); expect(closedCount).toBe(2);
  } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 15000);


test("one lazy worker keeps simultaneous pins/results/Stop isolated and reuses the warm runtime", async () => {
  let entered: () => void = () => {}, peerClosed: () => void = () => {};
  const held = new Promise<void>(done => { entered = done; }), disconnected = new Promise<void>(done => { peerClosed = done; });
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.host ?? "");
    if (request.url === "/hold") { request.socket.once("close", () => peerClosed()); response.writeHead(200); response.write("partial"); entered(); }
    else response.end(request.headers.host);
  });
  const target = await port(server); let starts = 0;
  const transport = createNodeRawHttpTransport(() => { starts++; return node; }); transports.push(transport);
  const controller = new AbortController();
  try {
    const first = transport.send(prepareRawHttpRequest({ url: `http://first.invalid:${target}/hold`, method: "GET", headers: {} }), loopback, controller.signal).catch(error => error);
    const second = transport.send(prepareRawHttpRequest({ url: `http://second.invalid:${target}/done`, method: "GET", headers: {} }), loopback, new AbortController().signal);
    await held; controller.abort(new Error("Cancel only first"));
    expect((await first).message).toBe("Cancel only first"); await disconnected;
    expect(Buffer.from((await second).bodyBase64, "base64").toString()).toBe(`second.invalid:${target}`);
    const warm = await transport.send(prepareRawHttpRequest({ url: `http://third.invalid:${target}/warm`, method: "GET", headers: {} }), loopback, new AbortController().signal);
    expect(Buffer.from(warm.bodyBase64, "base64").toString()).toBe(`third.invalid:${target}`); expect(starts).toBe(1); expect(seen).toHaveLength(3);
    await transport.close(); await expect(transport.send(prepareRawHttpRequest({ url: `http://unused.invalid:${target}/`, method: "GET", headers: {} }), loopback, new AbortController().signal)).rejects.toThrow("stopping");
  } finally { controller.abort(); await transport.close(); await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test("host trust rotation preserves an active call, refreshes the next generation and shutdown reaps both", async () => {
  let entered: () => void = () => {}, finish: () => void = () => {};
  const held = new Promise<void>(done => { entered = done; });
  const server = createServer((request, response) => {
    if (request.url === "/old") { finish = () => response.end("old-complete"); entered(); }
    else response.end("fresh-complete");
  });
  const target = await port(server); let starts = 0;
  const transport = createNodeRawHttpTransport(() => { starts++; return node; }); transports.push(transport);
  try {
    const old = transport.send(prepareRawHttpRequest({ url: `http://localhost:${target}/old`, method: "GET", headers: {} }), loopback, new AbortController().signal);
    await held; transport.rotate();
    const fresh = await transport.send(prepareRawHttpRequest({ url: `http://localhost:${target}/fresh`, method: "GET", headers: {} }), loopback, new AbortController().signal);
    expect(Buffer.from(fresh.bodyBase64, "base64").toString()).toBe("fresh-complete"); expect(starts).toBe(2);
    finish(); expect(Buffer.from((await old).bodyBase64, "base64").toString()).toBe("old-complete");
    await transport.close(); await transport.close();
  } finally { finish(); await transport.close(); await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test.skipIf(process.platform === "win32")("a crash after real origin I/O fails all pending without replay; only a new call restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hop-crash-")), pidPath = join(root, "owned.pid"), executable = join(root, "node");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidPath)}\nexec ${quote(node)} "$@"\n`); await chmod(executable, 0o700);
  const hits: string[] = []; let entered: () => void = () => {};
  const active = new Promise<void>(done => { entered = done; });
  const server = createServer((request, response) => { hits.push(request.url ?? ""); if (request.url === "/new") response.end("new"); else { response.writeHead(200); response.write("held"); if (hits.length === 2) entered(); } });
  const target = await port(server); let starts = 0;
  const transport = createNodeRawHttpTransport(() => { starts++; return executable; }); transports.push(transport);
  try {
    const run = (path: string) => transport.send(prepareRawHttpRequest({ url: `http://localhost:${target}${path}`, method: "GET", headers: {} }), loopback, new AbortController().signal);
    const pending = [run("/one").catch(error => error), run("/two").catch(error => error)]; await active;
    const pid = Number(await readFile(pidPath, "utf8")); expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    process.kill(pid, "SIGKILL");
    for (const error of await Promise.all(pending)) { expect(error).toBeInstanceOf(Error); expect(error.message).toContain("exited before cleanup"); }
    expect(starts).toBe(1); expect([...hits].sort()).toEqual(["/one", "/two"]);
    expect(Buffer.from((await run("/new")).bodyBase64, "base64").toString()).toBe("new"); expect(starts).toBe(2); expect([...hits].sort()).toEqual(["/new", "/one", "/two"]);
  } finally { await transport.close(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("concurrent calls keep distinct proxy snapshots and NO_PROXY inside one warm worker", async () => {
  const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const seen: string[] = [];
  const first = createServer((request, response) => { seen.push(`first:${request.headers.host}:${request.url}`); response.end("first-proxy"); });
  const second = createServer((request, response) => { seen.push(`second:${request.headers.host}:${request.url}`); response.end("second-proxy"); });
  const origin = createServer((_request, response) => response.end("direct"));
  const [one, two, direct] = await Promise.all([port(first), port(second), port(origin)]);
  let starts = 0; const transport = createNodeRawHttpTransport(() => { starts++; return node; }); transports.push(transport);
  const run = () => transport.send(prepareRawHttpRequest({ url: `http://pinned.invalid:${direct}/target`, method: "GET", headers: {} }), loopback, new AbortController().signal);
  try {
    for (const name of names) process.env[name] = "";
    process.env.HTTP_PROXY = `http://127.0.0.1:${one}`; const a = run();
    process.env.HTTP_PROXY = `http://127.0.0.1:${two}`; const b = run();
    process.env.NO_PROXY = "*"; const c = run();
    // Restore before the cold worker handshake: each call must retain its own snapshot.
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    const results = await Promise.all([a, b, c]);
    expect(results.map(result => Buffer.from(result.bodyBase64, "base64").toString())).toEqual(["first-proxy", "second-proxy", "direct"]);
    expect(seen.sort()).toEqual([`first:pinned.invalid:${direct}:http://127.0.0.1:${direct}/target`, `second:pinned.invalid:${direct}:http://127.0.0.1:${direct}/target`]); expect(starts).toBe(1);
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await transport.close(); await Promise.all([first, second, origin].map(server => new Promise<void>(done => server.close(() => done()))));
  }
}, 15000);

test("worker rejects early ACK, unknown cancellation and reuse of an already released ID", async () => {
  let hits = 0;
  const server = createServer((request, response) => { hits++; if (request.url === "/fast") response.end("done"); else { response.writeHead(200); response.write("pending"); } });
  const target = await port(server), id = "00000000-0000-0000-0000-000000000000:1";
  const next = (child: ChildProcess) => new Promise<ReturnType<typeof rawHttpNodeReply.parse>>(done => child.once("message", value => done(rawHttpNodeReply.parse(value))));
  try {
    const unknown = privateWorker(); await unknown.ready; unknown.child.send?.({ kind: "cancel", id }); expect((await unknown.end).code).toBe(1);
    const early = privateWorker(); await early.ready;
    const entered = new Promise<void>(done => server.once("request", () => done()));
    sendRequest(early.child, prepareRawHttpRequest({ url: `http://localhost:${target}/hold`, method: "GET", headers: {} }));
    await entered; early.child.send?.({ kind: "ack", id }); expect((await early.end).code).toBe(1); expect(Buffer.concat(early.errors).toString()).toContain("before actual socket cleanup");
    const replay = privateWorker(); await replay.ready;
    const settled = next(replay.child); const request = prepareRawHttpRequest({ url: `http://localhost:${target}/fast`, method: "GET", headers: {} }); sendRequest(replay.child, request);
    expect((await settled).kind).toBe("settled"); const released = next(replay.child); replay.child.send?.({ kind: "ack", id }); expect((await released).kind).toBe("released");
    sendRequest(replay.child, request); expect((await replay.end).code).toBe(1); expect(hits).toBe(2);
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test("normal transport shutdown settles every active socket, reaps its child and closes admission", async () => {
  let entered: () => void = () => {}, peerClosed: () => void = () => {}, opened = 0, ended = 0;
  const active = new Promise<void>(done => { entered = done; }), disconnected = new Promise<void>(done => { peerClosed = done; });
  const server = createServer((request, response) => {
    request.socket.once("close", () => { if (++ended === 2) peerClosed(); }); response.writeHead(200); response.write("pending"); if (++opened === 2) entered();
  });
  const target = await port(server), transport = createNodeRawHttpTransport(() => node); transports.push(transport);
  try {
    const pending = ["one", "two"].map(path => transport.send(prepareRawHttpRequest({ url: `http://localhost:${target}/${path}`, method: "GET", headers: {} }), loopback, new AbortController().signal).catch(error => error));
    await active; await transport.close(); await disconnected;
    for (const error of await Promise.all(pending)) expect(error.message).toBe("HTTP transport is stopping.");
    expect(ended).toBe(2);
    await expect(transport.send(prepareRawHttpRequest({ url: `http://localhost:${target}/unused`, method: "GET", headers: {} }), loopback, new AbortController().signal)).rejects.toThrow("stopping");
  } finally { await transport.close(); await new Promise<void>(done => server.close(() => done())); }
}, 15000);

test.skipIf(process.platform === "win32")("pre-ready cancellation preserves a waiting peer, then reaps the last caller's child before a fresh call", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hop-pre-ready-")), pidPath = join(root, "owned.pid"), stub = join(root, "held.cjs"), executable = join(root, "held-node");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(stub, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();process.on('message',()=>{});setInterval(()=>{},1000);`);
  await writeFile(executable, `#!/bin/sh\nexec ${quote(node)} ${quote(stub)}\n`); await chmod(executable, 0o700);
  let hits = 0, starts = 0, ownedPID = 0;
  const alive = () => { try { process.kill(ownedPID, 0); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; } };
  const server = createServer((_request, response) => { hits++; response.end("new-authorized-call"); }), target = await port(server);
  const transport = createNodeRawHttpTransport(() => {
    starts++;
    if (starts > 1 && alive()) throw new Error("Prior generation was not actually reaped before replacement");
    return starts === 1 ? executable : node;
  }); transports.push(transport);
  const first = new AbortController(), second = new AbortController();
  try {
    const request = prepareRawHttpRequest({ url: `http://localhost:${target}/`, method: "GET", headers: {} });
    const a = transport.send(request, loopback, first.signal).catch(error => error), b = transport.send(request, loopback, second.signal).catch(error => error);
    while (!await Bun.file(pidPath).exists()) await Bun.sleep(1);
    ownedPID = Number(await readFile(pidPath, "utf8")); expect(Number.isSafeInteger(ownedPID) && ownedPID > 0).toBe(true);
    first.abort(new Error("First waiting cancellation")); expect((await a).message).toBe("First waiting cancellation"); expect(alive()).toBe(true); expect(hits).toBe(0);
    second.abort(new Error("Last waiting cancellation"));
    const fresh = transport.send(request, loopback, new AbortController().signal);
    expect((await b).message).toBe("Last waiting cancellation"); expect(alive()).toBe(false);
    expect(Buffer.from((await fresh).bodyBase64, "base64").toString()).toBe("new-authorized-call"); expect(starts).toBe(2); expect(hits).toBe(1);
  } finally { await transport.close(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 15000);

test.skipIf(process.platform === "win32")("normal close reaps a never-ready owned child and settles every waiting call without a deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-hop-pre-ready-close-")), pidPath = join(root, "owned.pid"), stub = join(root, "held.cjs"), executable = join(root, "held-node");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(stub, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();process.on('message',()=>{});setInterval(()=>{},1000);`);
  await writeFile(executable, `#!/bin/sh\nexec ${quote(node)} ${quote(stub)}\n`); await chmod(executable, 0o700);
  const transport = createNodeRawHttpTransport(() => executable); transports.push(transport);
  try {
    const request = prepareRawHttpRequest({ url: "http://never-dispatched.invalid/", method: "GET", headers: {} });
    const pending = [1, 2].map(() => transport.send(request, loopback, new AbortController().signal).catch(error => error));
    while (!await Bun.file(pidPath).exists()) await Bun.sleep(1);
    const pid = Number(await readFile(pidPath, "utf8")); expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await transport.close();
    for (const error of await Promise.all(pending)) expect(error.message).toBe("HTTP transport is stopping.");
    let absent = false;
    try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") absent = true; else throw error; }
    expect(absent).toBe(true);
  } finally { await transport.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);
