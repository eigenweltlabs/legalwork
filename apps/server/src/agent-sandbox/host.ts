import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopHostProcessTree } from "./host-processes.js";
import { windowsHostEnvironment, windowsHostScript } from "./host-windows.js";
import { spawn } from "node:child_process";
import { sandboxResources, type SandboxResult } from "./vm.js";

export const hostShell = () => process.platform === "win32" ? "PowerShell" : "Bash";

/** Tool calls retain their existing capture/deadline defaults. Configured command
 * expansion requests complete output and no inference-independent deadline. */
export async function runHostCommand(input: { command: string; cwd: string; timeoutMs: number | null; capture?: "complete"; signal: AbortSignal }): Promise<SandboxResult> {
  input.signal.throwIfAborted();
  const windows = process.platform === "win32";
  const directory = windows ? await mkdtemp(join(tmpdir(), "legalwork-command-")) : undefined;
  const script = directory ? join(directory, "command.ps1") : "";
  try {
    if (directory) await writeFile(script, windowsHostScript(input.command), { mode: 0o600 });
    input.signal.throwIfAborted();
    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(windows ? join(sandboxResources(), "legalwork-host.exe") : "/bin/bash", windows
        ? [script]
        : ["-c", input.command], { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows,
          env: windows ? windowsHostEnvironment(process.env) : process.env });
      const chunks: Buffer[] = [];
      let size = 0, truncated = false, finished = false;
      let failure: Error | undefined;
      const capture = (data: Buffer) => {
        const remaining = input.capture === "complete" ? data.length : 1024 * 1024 - size;
        if (data.length > remaining) truncated = true;
        if (remaining > 0) { const part = data.subarray(0, remaining); chunks.push(part); size += part.length; }
      };
      let stopping: Promise<void> | undefined;
      const kill = (tree = false) => {
        if (!child.pid) return;
        if (windows) {
          // Closing the supervisor's job handle also terminates detached children.
          child.kill("SIGKILL");
        } else if (tree) {
          stopping ??= stopHostProcessTree(child.pid).catch(error => {
            failure ??= error instanceof Error ? error : new Error(String(error));
            child.kill("SIGKILL");
          });
        } else if (!stopping) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const finish = async (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        await stopping;
        if (error ?? failure) reject(error ?? failure);
        else resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 1, truncated });
      };
      const abort = () => { failure = new Error("Command cancelled because the request or permissions changed."); kill(true); };
      const timer = input.timeoutMs === null ? undefined : setTimeout(() => { failure = new Error("Command timed out."); kill(true); }, input.timeoutMs);
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", error => finish(null, error));
      // Cleanup also closes pipes held by background children.
      if (!windows) child.once("exit", () => kill());
      child.once("close", code => finish(code));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
