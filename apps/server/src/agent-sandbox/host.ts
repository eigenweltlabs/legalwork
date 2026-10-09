import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsHostScript } from "./host-windows.js";
import { spawn } from "node:child_process";
import type { SandboxResult } from "./vm.js";

export const hostShell = () => process.platform === "win32" ? "PowerShell" : "Bash";

/** Unprotected execution still has bounded output, cancellation and a deadline.
 * It deliberately has the user's OS access. Tool approvals are handled by the service. */
export async function runHostCommand(input: { command: string; cwd: string; timeoutMs: number; signal: AbortSignal }): Promise<SandboxResult> {
  input.signal.throwIfAborted();
  const windows = process.platform === "win32";
  const directory = windows ? await mkdtemp(join(tmpdir(), "legalwork-command-")) : undefined;
  const script = directory ? join(directory, "command.ps1") : "";
  try {
    if (directory) await writeFile(script, windowsHostScript(input.command), { mode: 0o600 });
    input.signal.throwIfAborted();
    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(windows ? "powershell.exe" : "/bin/bash", windows
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
        : ["-c", input.command], { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows });
      const chunks: Buffer[] = [];
      let size = 0, truncated = false, finished = false;
      let failure: Error | undefined;
      const capture = (data: Buffer) => {
        const remaining = 1024 * 1024 - size;
        if (data.length > remaining) truncated = true;
        if (remaining > 0) { const part = data.subarray(0, remaining); chunks.push(part); size += part.length; }
      };
      const kill = () => {
        if (!child.pid) return;
        if (windows) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill("SIGKILL"));
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const finish = (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (error ?? failure) reject(error ?? failure);
        else resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 1, truncated });
      };
      const abort = () => { failure = new Error("Command cancelled because the request or permissions changed."); kill(); };
      const timer = setTimeout(() => { failure = new Error("Command timed out."); kill(); }, input.timeoutMs);
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", error => finish(null, error));
      // Killing the process group on exit also closes pipes held by background children.
      if (!windows) child.once("exit", kill);
      child.once("close", code => finish(code));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
