import { execFile } from "node:child_process";
import { readFile, rename } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const execute = promisify(execFile);
const identitySchema = z.object({ name: z.string().min(1), created: z.string().datetime() });
export type WindowsProcessIdentity = z.infer<typeof identitySchema>;

async function identifyProcess(pid: number): Promise<WindowsProcessIdentity> {
  // CIM exposes a protected process's name and creation time without granting
  // termination rights. No command line, owner credentials or profile is read.
  const shell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($null -eq $p -or $null -eq $p.CreationDate){throw 'Process identity unavailable'};[ordered]@{name=$p.Name;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`;
  const result = await execute(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5000, windowsHide: true });
  return identitySchema.parse(JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()));
}

async function requireRefusedConnection(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("The previous engine listener could not be checked.")); }, 5000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("The previous engine address still has a listener.")); });
    socket.once("error", error => {
      clearTimeout(timer);
      if ("code" in error && error.code === "ECONNREFUSED") resolve();
      else reject(new Error("The previous engine listener could not be checked.", { cause: error }));
    });
  });
}

/** Only for Windows EPERM: a positively different executable owns this reused
 * PID, and the old authenticated service and TCP listener are both absent.
 * Clocks/mtime never establish process identity. Preserve the registration,
 * never signal the foreign process; unknown or matching engines stay blocked.
 */
export async function quarantineForeignWindowsService(input: {
  file: string; text: string; pid: number; url: URL; executablePath: string;
}, inspect = identifyProcess): Promise<void> {
  if (!Number.isInteger(input.pid) || input.pid <= 0 || !path.win32.isAbsolute(input.executablePath)) throw new Error("A verified managed engine executable is required for Windows recovery.");
  const engineNames = new Set(["opencode.exe", path.win32.basename(input.executablePath).toLowerCase()]);
  const first = identitySchema.parse(await inspect(input.pid));
  if (engineNames.has(first.name.toLowerCase())) throw new Error("The previous engine process cannot be safely identified as stale.");
  await requireRefusedConnection(input.url);
  const second = identitySchema.parse(await inspect(input.pid));
  if (first.name !== second.name || first.created !== second.created || await readFile(input.file, "utf8") !== input.text) throw new Error("The previous engine registration or process identity changed during recovery.");
  await rename(input.file, `${input.file}.stale-${randomUUID()}`);
}
