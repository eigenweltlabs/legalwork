import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Address, RawHttpNetwork, RawHttpRequest, HopResponse } from "./raw-http.js";
import { RAW_HTTP_NODE_CODE } from "./raw-http-node-code.js";
import { rawHttpNodeReply } from "./raw-http-node-contract.js";

/** Retain normal OS identity/root discovery, never app credentials or preload/CA bypass settings. */
export function rawHttpNodeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "path", "pathext", "temp", "tmp", "home", "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programdata", "lang", "lc_all", "lc_ctype", "tz", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.has(name.toLowerCase())));
}
function proxyEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"].flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]));
}
type Call = {
  id: string; request: RawHttpRequest; address: Address; addresses: Address[]; signal: AbortSignal;
  phase: "waiting" | "sent" | "releasing"; proxy: NodeJS.ProcessEnv; failure?: Error; result?: HopResponse;
  resolve: (value: HopResponse) => void; reject: (error: Error) => void; abort: () => void;
};
type Generation = {
  child: ChildProcess; calls: Map<string, Call>; ready: boolean; retiring: boolean; shutdown: boolean;
  failure?: Error; terminationRequested: boolean; terminationErrors: unknown[]; stderr: Buffer[];
  closed: Promise<void>; finish: () => void;
};
const failure = (value: unknown) => value instanceof Error ? value : new Error(String(value));
export type NodeRawHttpTransport = { send: RawHttpNetwork["send"]; rotate: () => void; close: () => Promise<void> };

/** One lazy host-owned Node/OpenSSL process. Calls never share clients, consent, pins or cancellation. */
export function createNodeRawHttpTransport(executable: () => string): NodeRawHttpTransport {
  const prefix = randomUUID(), generations = new Set<Generation>();
  let sequence = 0n, current: Generation | undefined, closing: Promise<void> | undefined, admissionClosed = false;
  function sendMessage(generation: Generation, value: object) {
    if (generation.failure) return;
    try {
      if (!generation.child.send) throw new Error("HTTP worker IPC is unavailable.");
      // false means backpressure, never permission to replay.
      generation.child.send(value, error => { if (error) failGeneration(generation, error); });
    } catch (error) { failGeneration(generation, error); }
  }
  function failGeneration(generation: Generation, error: unknown) {
    generation.failure ??= failure(error);
    if (current === generation) current = undefined;
    if (generation.terminationRequested || generation.child.exitCode !== null || generation.child.signalCode !== null) return;
    generation.terminationRequested = true;
    // kill can itself emit error: make one attempt and keep its diagnostics,
    // without recursion, retries or an event-handler exception.
    try { if (!generation.child.kill("SIGKILL") && generation.child.pid !== undefined) generation.terminationErrors.push(new Error("HTTP worker termination was not accepted.")); }
    catch (error) { generation.terminationErrors.push(error); }
  }
  function shutdownIfIdle(generation: Generation) {
    if (generation.failure || generation.shutdown || !generation.retiring || generation.calls.size) return;
    if (!generation.ready) { failGeneration(generation, new Error("HTTP worker closed before readiness.")); return; }
    generation.shutdown = true; sendMessage(generation, { kind: "shutdown" });
  }
  function complete(generation: Generation, call: Call) {
    generation.calls.delete(call.id); call.signal.removeEventListener("abort", call.abort);
    if (call.failure) call.reject(call.failure);
    else if (call.result) call.resolve(call.result);
    else call.reject(new Error("HTTP worker released a call without its result."));
    shutdownIfIdle(generation);
  }
  function cancel(generation: Generation, call: Call, reason: unknown) {
    call.failure ??= failure(reason);
    if (call.phase === "waiting") {
      if (!generation.ready && generation.calls.size === 1) {
        // Nothing has been sent to this child. Reap a stuck loader before
        // settling its last waiting caller, without interrupting any peer.
        generation.retiring = true; failGeneration(generation, call.failure);
      } else complete(generation, call);
    } else if (call.phase === "sent") sendMessage(generation, { kind: "cancel", id: call.id });
    // Once settled, sockets are already closed. Do not send a stale cancel
    // after ACK; retain the cancellation reason until released.
  }
  function dispatch(generation: Generation, call: Call) {
    if (call.signal.aborted) { cancel(generation, call, call.signal.reason); return; }
    call.phase = "sent";
    sendMessage(generation, { kind: "request", id: call.id, request: call.request, address: call.address, addresses: call.addresses, proxy: call.proxy });
  }
  function start(signal: AbortSignal): Generation {
    const program = executable(); signal.throwIfAborted();
    const child = spawn(program, ["-"], { env: rawHttpNodeEnvironment(process.env), stdio: ["pipe", "ignore", "pipe", "ipc"], serialization: "json", windowsHide: true });
    let finish: () => void = () => {};
    const generation: Generation = { child, calls: new Map(), ready: false, retiring: false, shutdown: false, terminationRequested: false, terminationErrors: [], stderr: [], closed: new Promise<void>(done => { finish = done; }), finish: () => finish() };
    generations.add(generation); current = generation;
    child.stderr?.on("data", chunk => generation.stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", error => { if (generation.terminationRequested) { generation.terminationErrors.push(error); generation.failure ??= error; } else failGeneration(generation, error); });
    child.stdin?.on("error", error => failGeneration(generation, error));
    child.on("message", value => {
      if (generation.failure) return;
      const parsed = rawHttpNodeReply.safeParse(value);
      if (!parsed.success) { failGeneration(generation, new Error("Invalid private HTTP worker reply.", { cause: parsed.error })); return; }
      const reply = parsed.data;
      if (!generation.ready) {
        if (reply.kind !== "ready" || reply.pid !== child.pid) { failGeneration(generation, new Error("HTTP worker replied before its ready handshake.")); return; }
        generation.ready = true;
        for (const call of generation.calls.values()) dispatch(generation, call);
        shutdownIfIdle(generation); return;
      }
      if (reply.kind === "ready") { failGeneration(generation, new Error("Duplicate HTTP worker handshake.")); return; }
      const call = generation.calls.get(reply.id);
      if (!call) { failGeneration(generation, new Error("Unknown or duplicate HTTP worker reply.")); return; }
      if (reply.kind === "settled") {
        if (call.phase !== "sent") { failGeneration(generation, new Error("Early or duplicate HTTP worker settlement.")); return; }
        const outcome = reply.outcome;
        if (outcome.kind === "result") call.result = outcome.result;
        else call.failure ??= Object.assign(new Error(outcome.error.message), { name: outcome.error.name, stack: outcome.error.stack, ...(outcome.error.code ? { code: outcome.error.code } : {}), workerDetails: outcome.error.details });
        call.phase = "releasing"; sendMessage(generation, { kind: "ack", id: call.id });
      } else {
        if (call.phase !== "releasing") { failGeneration(generation, new Error("HTTP worker released a call before settlement.")); return; }
        complete(generation, call);
      }
    });
    child.once("close", (code, signal) => {
      if (current === generation) current = undefined;
      const stderr = Buffer.concat(generation.stderr).toString("utf8");
      const error = generation.failure ?? new Error(`HTTP worker exited before cleanup (code ${code}, signal ${signal}).`);
      for (const call of generation.calls.values()) {
        call.signal.removeEventListener("abort", call.abort);
        call.reject(Object.assign(call.failure ?? error, { workerStderr: stderr, workerExitCode: code, workerSignal: signal,
          ...(generation.terminationErrors.length ? { workerTerminationErrors: generation.terminationErrors } : {}) }));
      }
      if (!generation.calls.size && (generation.failure || code !== 0 || !generation.shutdown) && stderr) console.warn("[raw-http-node] Worker stderr:", stderr);
      generation.calls.clear(); generations.delete(generation); generation.finish();
    });
    child.stdin?.end(RAW_HTTP_NODE_CODE);
    return generation;
  }
  return {
    send(request, address, signal, addresses = [address]) {
      signal.throwIfAborted();
      if (admissionClosed) return Promise.reject(new Error("HTTP transport is stopping."));
      return new Promise<HopResponse>((resolve, reject) => {
        const assign = async () => {
          // A failed generation must actually close before a later new call
          // can start a fresh child. Never replay an assigned failed call.
          for (const generation of generations) if (generation.failure) await generation.closed;
          signal.throwIfAborted();
          if (admissionClosed) throw new Error("HTTP transport is stopping.");
          const generation = current ?? start(signal);
          signal.throwIfAborted();
          const call: Call = { id: `${prefix}:${++sequence}`, request, address, addresses, signal, resolve, reject, phase: "waiting", proxy: proxyEnvironment(process.env), abort: () => {} };
          call.abort = () => cancel(generation, call, signal.reason);
          generation.calls.set(call.id, call); signal.addEventListener("abort", call.abort, { once: true });
          if (signal.aborted) call.abort(); else if (generation.ready) dispatch(generation, call);
        };
        void assign().catch(error => reject(failure(error)));
      });
    },
    rotate() {
      if (!current) return;
      const retiring = current; current = undefined; retiring.retiring = true; shutdownIfIdle(retiring);
    },
    close() {
      if (closing) return closing;
      admissionClosed = true; current = undefined;
      for (const generation of generations) {
        generation.retiring = true;
        for (const call of generation.calls.values()) cancel(generation, call, new Error("HTTP transport is stopping."));
        shutdownIfIdle(generation);
      }
      closing = Promise.all([...generations].map(generation => generation.closed)).then(() => {});
      return closing;
    },
  };
}
