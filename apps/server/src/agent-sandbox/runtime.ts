import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const envelope = z.object({ run: z.string().regex(/^[a-f0-9]{32}$/), payload: z.unknown() });
const boot = z.object({ protocol: z.literal(4) });
const FRAME_LIMIT = 24 * 1024 * 1024;
type Run = { receive: (event: unknown) => void; fail: (error: Error) => void };

async function connectPipe(name: string, signal: AbortSignal): Promise<Socket> {
  while (true) {
    signal.throwIfAborted();
    const socket = createConnection(`\\\\.\\pipe\\${name}`);
    try { await once(socket, "connect", { signal }); return socket; }
    catch (error) {
      socket.destroy();
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await delay(50, undefined, { signal });
    }
  }
}

/** One transport per server/runtime. Only the trusted guest supervisor can
 * label a worker's pipe with a run identity. Host grants remain separate. */
export class SharedVmRuntime {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly controller = new AbortController();
  private readonly runs = new Map<string, Run>();
  private readonly ready: Promise<void>;
  private readonly closed: Promise<void>;
  private writer: NodeJS.WritableStream;
  private pipe?: Socket;
  private idle?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private stderr = "";
  private writes = Promise.resolve();
  private users = 0;

  constructor(executable: string, args: string[], diagnostics: string,
    consolePath: string, private readonly onClose: () => void, pipeName?: string) {
    this.child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    this.writer = this.child.stdin;
    const timeout = setTimeout(() => this.stop(new Error("Protected runtime startup timed out.")), 180000);
    let pending = "", started = false;
    this.ready = new Promise<void>((resolve, reject) => {
      this.controller.signal.addEventListener("abort", () => reject(this.failure), { once: true });
      const receive = (chunk: Buffer) => {
        pending += chunk.toString();
        try {
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            if (newline > FRAME_LIMIT) throw new Error("Sandbox protocol frame exceeded its limit.");
            const raw: unknown = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (!started) { boot.parse(raw); started = true; clearTimeout(timeout); resolve(); }
            else {
              const event = envelope.parse(raw);
              this.runs.get(event.run)?.receive(event.payload);
            }
          }
          if (pending.length > FRAME_LIMIT) throw new Error("Sandbox protocol frame exceeded its limit.");
        } catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
      };
      if (pipeName) {
        void connectPipe(pipeName, this.controller.signal).then((socket) => {
          this.pipe = socket; this.writer = socket;
          socket.on("data", receive);
          socket.on("error", (error) => this.stop(error));
          socket.on("end", () => this.stop(new Error("Sandbox channel closed.")));
        }).catch((error: unknown) => this.stop(error instanceof Error ? error : new Error(String(error))));
      } else this.child.stdout.on("data", receive);
    });
    // A caller can cancel while boot is still in flight.
    void this.ready.catch(() => {});
    this.child.on("error", (error) => this.stop(error));
    this.child.stdin.on("error", (error) => this.stop(error));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    const exit = () => this.child.kill("SIGKILL");
    process.once("exit", exit);
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", () => {
        clearTimeout(timeout);
        process.removeListener("exit", exit);
        void (async () => {
          const log = await readFile(consolePath, "utf8").catch(() => "");
          const error = new Error(`${this.failure?.message ?? "Protected runtime stopped unexpectedly."}\n${this.stderr}\n${log.slice(-8192)}`);
          this.stop(error);
          for (const run of this.runs.values()) run.fail(error);
          this.runs.clear();
          // Diagnostic cleanup must not strand callers after the VM has exited.
          await rm(diagnostics, { recursive: true, force: true }).catch(() => {});
          resolve();
        })();
      });
    });
  }

  stop(error = new Error("Protected runtime stopped.")): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.idle);
    this.onClose();
    this.controller.abort(error);
    this.pipe?.destroy();
    this.child.kill("SIGKILL");
  }

  async close(): Promise<void> { this.stop(); await this.closed; }

  private send(message: unknown): Promise<void> {
    this.writes = this.writes.then(async () => {
      this.controller.signal.throwIfAborted();
      if (!this.writer.write(JSON.stringify(message) + "\n"))
        await once(this.writer, "drain", { signal: this.controller.signal });
    });
    return this.writes;
  }

  async execute(config: unknown, signal: AbortSignal,
    handle: (event: unknown, reply: (message: unknown) => Promise<void>, finish: (error?: Error) => void) => void): Promise<void> {
    clearTimeout(this.idle);
    this.users++;
    const ident = randomUUID().replaceAll("-", "");
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void this.ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      this.controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        let cancellation: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
          clearTimeout(cancellation);
          signal.removeEventListener("abort", abort);
          this.runs.delete(ident);
          if (signal.aborted) reject(signal.reason);
          else if (error) reject(error);
          else resolve();
        };
        const reply = (message: unknown) => {
          signal.throwIfAborted();
          if (!this.runs.has(ident)) return Promise.resolve();
          return this.send({ op: "reply", run: ident, payload: message });
        };
        const abort = () => {
          // Revoke host operations immediately; allow the guest to acknowledge
          // process cleanup. An unresponsive supervisor invalidates the VM.
          void this.send({ op: "cancel", run: ident }).catch((error: unknown) => this.stop(new Error(String(error))));
          cancellation = setTimeout(() => this.stop(new Error("Protected command cancellation timed out.")), 10000);
        };
        this.runs.set(ident, { receive: (event) => handle(event, reply, finish), fail: finish });
        signal.addEventListener("abort", abort, { once: true });
        void this.send({ op: "run", run: ident, config }).catch((error: unknown) => this.stop(new Error(String(error))));
        if (signal.aborted) abort();
      });
    } finally {
      this.users--;
      if (!this.users && !this.failure) {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => this.stop(new Error("Protected runtime was idle.")), 30000);
        this.idle.unref();
      }
    }
  }
}
