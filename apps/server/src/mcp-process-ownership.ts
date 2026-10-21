import { execFile } from "node:child_process";
import { readFile, realpath, access } from "node:fs/promises";
import { dirname, join, resolve, win32, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const pathsSchema = z.record(z.string(), z.string());
type Paths = Record<string, string>;

// Query only path variables, never serialize a process's full environment or
// command line. Protected/uninspectable processes remain an ownership conflict.
const windowsReader = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LegalWorkMcpPaths {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr Reserved1, Peb, Reserved2a, Reserved2b, Pid, Reserved3; }
  [StructLayout(LayoutKind.Sequential)] struct Region { public IntPtr Base, AllocationBase; public uint AllocationProtect; public UIntPtr Size; public uint State, Protect, Type; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("kernel32.dll")] static extern UIntPtr VirtualQueryEx(IntPtr handle, IntPtr address, out Region region, UIntPtr size);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process2(IntPtr handle, out ushort process, out ushort native);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, out Basic info, int size, out int returned);
  static IntPtr Pointer(IntPtr handle, IntPtr address) {
    var bytes = new byte[8]; UIntPtr read;
    if (!ReadProcessMemory(handle, address, bytes, (UIntPtr)8, out read) || read.ToUInt64() != 8) throw new Exception();
    return new IntPtr(BitConverter.ToInt64(bytes, 0));
  }
  public static Dictionary<string,string> Read(int pid) {
    if (IntPtr.Size != 8) return null;
    var handle = OpenProcess(0x410, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      ushort machine, native;
      if (!IsWow64Process2(handle, out machine, out native) || machine == 0x14c || machine == 0x1c4) return null;
      Basic basic; int returned;
      if (NtQueryInformationProcess(handle, 0, out basic, Marshal.SizeOf(typeof(Basic)), out returned) != 0) return null;
      var parameters = Pointer(handle, IntPtr.Add(basic.Peb, 0x20));
      var environment = Pointer(handle, IntPtr.Add(parameters, 0x80));
      Region region;
      if (VirtualQueryEx(handle, environment, out region, (UIntPtr)Marshal.SizeOf(typeof(Region))) == UIntPtr.Zero) return null;
      long length = Math.Min(1048576, (long)region.Size.ToUInt64() - (environment.ToInt64() - region.Base.ToInt64()));
      if (length <= 0) return null;
      var bytes = new byte[length]; UIntPtr read;
      if (!ReadProcessMemory(handle, environment, bytes, (UIntPtr)length, out read)) return null;
      var text = Encoding.Unicode.GetString(bytes, 0, (int)read.ToUInt64());
      var end = text.IndexOf("\0\0", StringComparison.Ordinal);
      if (end < 0) return null;
      var result = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      foreach (var entry in text.Substring(0, end).Split('\0')) {
        var split = entry.IndexOf('='); if (split <= 0) continue;
        var name = entry.Substring(0, split);
        if (name.Equals("USERPROFILE", StringComparison.OrdinalIgnoreCase) || name.Equals("XDG_DATA_HOME", StringComparison.OrdinalIgnoreCase)) result.Add(name.ToUpperInvariant(), entry.Substring(split + 1));
      }
      return result;
    } catch { return null; } finally { CloseHandle(handle); }
  }
}
'@
$results = @{}
foreach ($targetPid in TARGET_PIDS) {
  $paths = [LegalWorkMcpPaths]::Read($targetPid)
  $results[[string]$targetPid] = @{ paths = $paths; exited = ($null -eq (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) }
}
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`;

async function macHelper() {
  const resources: unknown = Reflect.get(process, "resourcesPath");
  const candidates = [
    ...(typeof resources === "string" ? [join(resources, "helpers/LegalWorkProcessInfo")] : []),
    fileURLToPath(new URL("../resources/helpers/LegalWorkProcessInfo", import.meta.url)),
    resolve(dirname(process.execPath), "../../resources/helpers/LegalWorkProcessInfo"),
  ];
  for (const path of candidates) if (await access(path).then(() => true, () => false)) return path;
  return undefined;
}

export function processAuthPath(paths: Paths, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const data = paths.XDG_DATA_HOME;
  // OpenCode accepts relative XDG paths too. Without its working directory we
  // cannot prove their ownership; do not incorrectly assume the home default.
  if (data) return path.isAbsolute(data) ? path.join(data, "opencode", "mcp-auth.json") : undefined;
  const home = platform === "win32" ? paths.USERPROFILE : paths.HOME;
  return home && path.isAbsolute(home) ? path.join(home, ".local", "share", "opencode", "mcp-auth.json") : undefined;
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    return parent === path ? path : join(await canonical(parent), path.slice(parent.length));
  }
}

export async function sameAuthPath(a: string, b: string) {
  const normalized = await Promise.all([canonical(a), canonical(b)]);
  return process.platform === "win32" ? normalized[0]!.toLowerCase() === normalized[1]!.toLowerCase() : normalized[0] === normalized[1];
}

export async function processesUsingAuthPath(pids: number[], authPath: string) {
  if (!pids.length) return false;
  const found = new Map<number, { paths?: Paths; exited: boolean }>();
  if (process.platform === "win32") {
    const script = windowsReader.replace("TARGET_PIDS", `@(${pids.join(",")})`);
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true });
    const entries = z.record(z.string(), z.object({ paths: pathsSchema.nullable(), exited: z.boolean() })).parse(JSON.parse(result.stdout));
    for (const [pid, value] of Object.entries(entries)) found.set(Number(pid), { paths: value.paths ?? undefined, exited: value.exited });
  } else {
    const helper = process.platform === "darwin" ? await macHelper() : undefined;
    await Promise.all(pids.map(async pid => {
      try {
        let paths: Paths;
        if (process.platform === "darwin") {
          if (!helper) return;
          const result = await run(helper, [String(pid)], { timeout: 2000, maxBuffer: 1024 * 1024 });
          paths = pathsSchema.parse(JSON.parse(result.stdout));
        } else if (process.platform === "linux") {
          paths = {};
          for (const entry of (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0")) {
            const split = entry.indexOf("=");
            const name = entry.slice(0, split);
            if (!["HOME", "XDG_DATA_HOME"].includes(name)) continue;
            if (name in paths) return;
            paths[name] = entry.slice(split + 1);
          }
        } else return;
        found.set(pid, { paths, exited: false });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === 3)) found.set(pid, { exited: true });
      }
    }));
  }
  for (const pid of pids) {
    const item = found.get(pid);
    if (item?.exited) continue;
    const source = item?.paths && processAuthPath(item.paths);
    if (!source || await sameAuthPath(source, authPath)) return true;
  }
  return false;
}
