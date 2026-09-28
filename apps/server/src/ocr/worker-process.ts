import { spawn, type ChildProcess } from "node:child_process";
import { OcrError } from "./types.js";

type Command = {
  /** Absolute executable and script paths; no shell commands or user-controlled arguments. */
  executable: string; args: string[]; env: NodeJS.ProcessEnv;
  /** Largest reply line accepted, in characters. */
  maxReply: number;
  /** Error messages for a missing runtime and for any other failure. */
  unavailable: string; failed: string;
};

/** A worker that keeps its model loaded between requests: one JSON request per stdin line, one JSON reply
 * ({ id, result } or { id, error }) per stdout line. Requests run one at a time. Cancelling a request kills
 * the process, so the next request starts a fresh one; an idle process exits on its own. */
export class WorkerProcess {
  private child?: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private next = 0;

  constructor(private readonly command: Command, private readonly idleMs = 120_000) {}

  request(payload: object, signal: AbortSignal): Promise<unknown> {
    const run = this.queue.then(() => this.send(payload, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close() {
    clearTimeout(this.idle);
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  private start() {
    const child = spawn(this.command.executable, this.command.args, { env: this.command.env, stdio: ["pipe", "pipe", "ignore"] });
    // Never forward stderr: it may contain document text, paths, or runtime environment details.
    child.stdin?.on("error", () => { /* The exit handler reports a worker that died. */ });
    child.stdout?.setEncoding("utf8");
    const forget = () => { if (this.child === child) this.child = undefined; };
    child.on("exit", forget);
    child.on("error", forget);
    this.child = child;
    return child;
  }

  private send(payload: object, signal: AbortSignal) {
    signal.throwIfAborted();
    clearTimeout(this.idle);
    const id = ++this.next, child = this.child ?? this.start();
    return new Promise<unknown>((resolve, reject) => {
      let parts: string[] = [], size = 0;
      const finish = (error?: unknown, value?: unknown, restart = true) => {
        child.stdout?.off("data", data);
        child.off("exit", exit);
        child.off("error", failed);
        signal.removeEventListener("abort", abort);
        if (error === undefined) { resolve(value); return; }
        if (restart) this.close();
        reject(error);
      };
      const fail = (code: "runtime-unavailable" | "local-failed", restart = true) =>
        finish(new OcrError(code, code === "runtime-unavailable" ? this.command.unavailable : this.command.failed), undefined, restart);
      const data = (chunk: string) => {
        const newline = chunk.indexOf("\n");
        parts.push(newline < 0 ? chunk : chunk.slice(0, newline));
        size += newline < 0 ? chunk.length : newline;
        if (size > this.command.maxReply) { finish(new OcrError("invalid-response", "The local worker's reply exceeded its size limit.")); return; }
        if (newline < 0) return;
        let reply: unknown;
        try { reply = JSON.parse(parts.join("")); } catch { reply = undefined; }
        parts = []; size = 0;
        // Anything but the reply to this request means the protocol is out of step: restart the worker.
        if (!reply || typeof reply !== "object" || Reflect.get(reply, "id") !== id) fail("local-failed");
        // A page the worker could not process leaves it loaded for the next page.
        else if (Reflect.has(reply, "error")) fail(Reflect.get(reply, "error") === "unavailable" ? "runtime-unavailable" : "local-failed", false);
        else finish(undefined, Reflect.get(reply, "result"));
      };
      const exit = (code: number | null) => fail(code === 3 ? "runtime-unavailable" : "local-failed");
      const failed = (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? "runtime-unavailable" : "local-failed");
      const abort = () => finish(signal.reason);
      child.stdout?.on("data", data);
      child.on("exit", exit);
      child.on("error", failed);
      signal.addEventListener("abort", abort, { once: true });
      child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`);
    }).finally(() => {
      if (!this.child) return;
      this.idle = setTimeout(() => this.close(), this.idleMs);
      this.idle.unref();
    });
  }
}
