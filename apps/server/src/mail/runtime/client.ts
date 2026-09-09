import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { probeWorkerExecutable, workerEnvironment, type WorkerExecutable } from "./executable.js";
import { MAX_WORKER_MESSAGE_BYTES, parseParentMessage, parseWorkerMessage, resultMatchesCommand, validWorkerCommand,
  type ParentMessage, type WorkerCommand, type WorkerInitialization, type WorkerResult } from "./protocol.js";

type State = "stopped" | "starting" | "ready" | "backoff" | "stopping" | "failed";
export type WorkerDiagnostic = { event: "ready" | "failure" | "restart_scheduled" | "stopped"; code: string; restarts: number };
export type MailWorkerOptions = {
  executable: WorkerExecutable;
  entryPoint: string;
  /** Re-read current secrets on every launch. The transport does not persist initialization. */
  initialize: () => WorkerInitialization | Promise<WorkerInitialization>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxPending?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  onDiagnostic?: (diagnostic: WorkerDiagnostic) => void;
};
type Pending = { command: WorkerCommand; resolve: (result: WorkerResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error("mail_worker_configuration_invalid");
  return result;
}

/** Supervises a real worker entrypoint. This class supplies no database/provider implementation. */
export class MailWorkerClient {
  private state: State = "stopped";
  private child?: ChildProcessWithoutNullStreams;
  private wanted = false;
  private generation = 0;
  private sequence = 0;
  private restarts = 0;
  private pending = new Map<string, Pending>();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private abortPreparation?: () => void;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private resolveStartup?: () => void;
  private rejectStartup?: (error: Error) => void;
  private startupMs: number;
  private requestMs: number;
  private shutdownMs: number;
  private maxPending: number;
  private maxRestarts: number;
  private restartDelay: number;
  private maxRestartDelay: number;

  constructor(private readonly options: MailWorkerOptions) {
    if (!isAbsolute(options.entryPoint) || options.entryPoint.includes("\0")) throw new Error("mail_worker_entrypoint_invalid");
    this.startupMs = bounded(options.startupTimeoutMs, 10_000, 10, 60_000);
    this.requestMs = bounded(options.requestTimeoutMs, 30_000, 10, 300_000);
    this.shutdownMs = bounded(options.shutdownTimeoutMs, 3_000, 10, 30_000);
    this.maxPending = bounded(options.maxPending, 32, 1, 256);
    this.maxRestarts = bounded(options.maxRestarts, 3, 0, 10);
    this.restartDelay = bounded(options.restartDelayMs, 250, 10, 30_000);
    this.maxRestartDelay = bounded(options.maxRestartDelayMs, 5_000, this.restartDelay, 60_000);
  }

  status(): { state: State; restarts: number; pending: number } {
    return { state: this.state, restarts: this.restarts, pending: this.pending.size };
  }
  private diagnostic(event: WorkerDiagnostic["event"], code: string): void {
    try { this.options.onDiagnostic?.({ event, code, restarts: this.restarts }); } catch { /* Diagnostics cannot interrupt cleanup. */ }
  }
  private rejectPending(code: string): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(code)); }
    this.pending.clear();
  }
  private fail(code: string): void {
    clearTimeout(this.startupTimer);
    this.rejectStartup?.(new Error(code));
    this.rejectStartup = undefined;
    this.resolveStartup = undefined;
    this.rejectPending(code);
    this.diagnostic("failure", code);
    this.state = this.wanted ? "failed" : "stopping";
    this.child?.kill("SIGKILL");
  }
  private scheduleRestart(): void {
    if (!this.wanted || this.restarts >= this.maxRestarts) { this.state = this.wanted ? "failed" : "stopped"; return; }
    const delay = Math.min(this.maxRestartDelay, this.restartDelay * 2 ** this.restarts);
    this.restarts++;
    this.state = "backoff";
    this.diagnostic("restart_scheduled", "mail_worker_restart");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.wanted) void this.launch().catch(() => { /* Failure reported and budgeted by launch. */ });
    }, delay);
  }

  start(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.state === "stopping" || this.state === "backoff" || this.child) return Promise.reject(new Error("mail_worker_not_ready"));
    this.wanted = true;
    this.restarts = 0;
    return this.launch();
  }
  private launch(): Promise<void> {
    const generation = ++this.generation;
    this.state = "starting";
    const promise = this.performLaunch(generation);
    this.startPromise = promise;
    void promise.finally(() => { if (this.startPromise === promise) this.startPromise = undefined; }).catch(() => {});
    return promise;
  }
  private async performLaunch(generation: number): Promise<void> {
    let initialization: WorkerInitialization;
    let preparationTimer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      this.abortPreparation = () => reject(new Error("mail_worker_stopped"));
    });
    try {
      initialization = await Promise.race([
        (async () => {
          await probeWorkerExecutable(this.options.executable);
          if (!this.wanted || generation !== this.generation) throw new Error("mail_worker_stopped");
          return this.options.initialize();
        })(),
        new Promise<never>((_, reject) => {
          preparationTimer = setTimeout(() => reject(new Error("mail_worker_start_timeout")), this.startupMs);
        }),
        aborted,
      ]);
    } catch {
      if (generation === this.generation && this.wanted) {
        this.diagnostic("failure", "mail_worker_start_failed");
        this.scheduleRestart();
      }
      throw new Error(this.wanted ? "mail_worker_start_failed" : "mail_worker_stopped");
    } finally {
      clearTimeout(preparationTimer);
      if (generation === this.generation) this.abortPreparation = undefined;
    }
    if (!this.wanted || generation !== this.generation) throw new Error("mail_worker_stopped");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.executable.path, [this.options.entryPoint], {
        stdio: ["pipe", "pipe", "pipe"], env: workerEnvironment(this.options.executable), windowsHide: true,
      });
    } catch {
      this.diagnostic("failure", "mail_worker_spawn_failed");
      this.scheduleRestart();
      throw new Error("mail_worker_spawn_failed");
    }
    this.child = child;
    let buffer = Buffer.alloc(0);
    const startup = new Promise<void>((resolve, reject) => { this.resolveStartup = resolve; this.rejectStartup = reject; });
    this.startupTimer = setTimeout(() => this.fail("mail_worker_start_timeout"), this.startupMs);
    child.on("error", () => { if (this.child === child) this.fail("mail_worker_spawn_failed"); });
    child.stdin.on("error", () => { if (this.child === child && this.state !== "stopping") this.fail("mail_worker_pipe_failed"); });
    // Drain and discard all child stderr; never log provider errors, paths, messages or secrets.
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.state === "stopping" || this.state === "failed") return;
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(10);
      while (newline !== -1) {
        if (newline > MAX_WORKER_MESSAGE_BYTES) { this.fail("mail_worker_message_too_large"); return; }
        const message = parseWorkerMessage(buffer.subarray(0, newline).toString("utf8"));
        buffer = buffer.subarray(newline + 1);
        if (!message) { this.fail("mail_worker_protocol_error"); return; }
        if (message.kind === "ready") {
          if (this.state !== "starting" || Number(message.nodeVersion.split(".")[0]) < 22) { this.fail("mail_worker_protocol_error"); return; }
          clearTimeout(this.startupTimer);
          this.state = "ready";
          this.resolveStartup?.();
          this.resolveStartup = undefined;
          this.rejectStartup = undefined;
          this.diagnostic("ready", "mail_worker_ready");
        } else {
          const pending = this.pending.get(message.id);
          if (this.state !== "ready" || !pending || (message.ok && !resultMatchesCommand(pending.command, message.result))) { this.fail("mail_worker_protocol_error"); return; }
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(`mail_worker_${message.code}`));
        }
        newline = buffer.indexOf(10);
      }
      if (buffer.length > MAX_WORKER_MESSAGE_BYTES) this.fail("mail_worker_message_too_large");
    });
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = undefined;
      clearTimeout(this.startupTimer);
      this.rejectStartup?.(new Error("mail_worker_exited"));
      this.rejectStartup = undefined;
      this.resolveStartup = undefined;
      this.rejectPending(this.wanted ? "mail_worker_exited" : "mail_worker_stopped");
      if (this.wanted) { this.diagnostic("failure", "mail_worker_exited"); this.scheduleRestart(); }
      else { this.state = "stopped"; this.diagnostic("stopped", "mail_worker_stopped"); }
    });
    try { this.write({ kind: "initialize", protocol: 1, initialization }); }
    catch { this.fail("mail_worker_initialization_invalid"); }
    return startup;
  }
  private write(message: ParentMessage): void {
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_WORKER_MESSAGE_BYTES) throw new Error("mail_worker_message_too_large");
    if (!parseParentMessage(encoded)) throw new Error("mail_worker_protocol_error");
    if (!this.child || !this.child.stdin.writable) throw new Error("mail_worker_not_ready");
    this.child.stdin.write(`${encoded}\n`);
  }
  request(command: WorkerCommand): Promise<WorkerResult> {
    if (!validWorkerCommand(command)) return Promise.reject(new Error("mail_worker_command_invalid"));
    if (this.state !== "ready") return Promise.reject(new Error("mail_worker_not_ready"));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("mail_worker_busy"));
    const id = `${this.generation}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation has an unknown outcome. Never replay it; terminate this generation.
        this.fail("mail_worker_request_timeout");
      }, this.requestMs);
      this.pending.set(id, { command, resolve, reject, timer });
      try { this.write({ kind: "request", id, command }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("mail_worker_request_rejected"));
      }
    });
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.wanted = false;
    this.abortPreparation?.();
    this.abortPreparation = undefined;
    this.generation++;
    clearTimeout(this.restartTimer);
    clearTimeout(this.startupTimer);
    this.restartTimer = undefined;
    this.rejectStartup?.(new Error("mail_worker_stopped"));
    this.rejectStartup = undefined;
    this.resolveStartup = undefined;
    this.rejectPending("mail_worker_stopped");
    const child = this.child;
    if (!child) { this.state = "stopped"; return Promise.resolve(); }
    this.state = "stopping";
    const promise = new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => child.kill("SIGKILL"), this.shutdownMs);
      child.once("close", () => { clearTimeout(forceKill); resolve(); });
      try { this.write({ kind: "shutdown" }); child.stdin.end(); }
      catch { child.kill("SIGKILL"); }
    });
    this.stopPromise = promise;
    void promise.finally(() => { if (this.stopPromise === promise) this.stopPromise = undefined; });
    return promise;
  }
}
