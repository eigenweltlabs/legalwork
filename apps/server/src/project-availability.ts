import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isCloudFolder } from "./cloud-folder.js";

type PinResult = "requested" | "unsupported";
const attempts = new Map<string, { identity: string; expires: number; work: Promise<void> }>();
const warnings = new Set<string>();
const pinAttribute = "com.apple.fileprovider.pinned#PX";

function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((done, reject) => {
    const child = execFile(command, args, { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => error ? reject(error) : done(stdout));
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}

/** Do not follow custom helper links into documents or another project. */
async function entries(directory: string): Promise<string[]> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) return [];
  if (info.isFile()) return [directory];
  if (!info.isDirectory()) return [];
  const children = await readdir(directory);
  return [directory, ...(await Promise.all(children.map(name => entries(join(directory, name))))).flat()];
}

async function pinMac(directory: string): Promise<PinResult> {
  // macOS has no public third-party setter for Finder's persistent pin. Use
  // Finder's File Provider attribute only after its own diagnostic identifies
  // the item, and require provider acknowledgement instead of trusting xattr.
  const before = await run("/usr/bin/fileproviderctl", ["evaluate", directory]).catch(async error => {
    if (!await isCloudFolder(directory)) return "";
    throw error;
  });
  if (!/\bisKeepDownloaded\s*=\s*[01];/.test(before)) return "unsupported";
  const paths = await entries(directory);
  for (let offset = 0; offset < paths.length; offset += 50) {
    await run("/usr/bin/xattr", ["-s", "-w", pinAttribute, "1", ...paths.slice(offset, offset + 50)]);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const after = await run("/usr/bin/fileproviderctl", ["evaluate", directory]);
    if (/\bisKeepDownloaded\s*=\s*1;/.test(after)) return "requested";
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error("File Provider did not acknowledge Keep Downloaded");
}

// Fixed source; paths are JSON on stdin, never interpolated into PowerShell.
const windowsScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LegalWorkCloudPin {
  [DllImport("cldapi.dll", CharSet=CharSet.Unicode)]
  static extern int CfGetSyncRootInfoByPath(string path, int infoClass, IntPtr info, uint length, out uint returned);
  [DllImport("cldapi.dll")]
  static extern int CfSetPinState(SafeFileHandle file, int state, uint flags, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
  public static bool IsCloud(string path) {
    var buffer=Marshal.AllocHGlobal(65536);
    try { uint returned; return CfGetSyncRootInfoByPath(path,0,buffer,65536,out returned)==0; }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void Pin(string path) {
    // Open the entry itself, without following reparse points. FILE_READ_DATA
    // is required by CfSetPinState; sharing preserves concurrent engine access.
    using(var file=CreateFileW(path,1,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(file.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      // Each supplied entry was enumerated without following links. Pinning
      // directories also establishes inheritance for subsequently added files.
      Marshal.ThrowExceptionForHR(CfSetPinState(file,1,0,IntPtr.Zero));
    }
  }
}
'@
$inputData=ConvertFrom-Json ([Console]::In.ReadToEnd())
$states=@(foreach ($entry in @($inputData)) {
  try {
    if (-not [IO.Directory]::Exists($entry.directory)) { throw 'Project state folder is unavailable' }
    if (-not [LegalWorkCloudPin]::IsCloud($entry.directory)) { 'unsupported'; continue }
    foreach ($path in $entry.paths) { [LegalWorkCloudPin]::Pin($path) }
    'requested'
  } catch { 'failed' }
})
ConvertTo-Json -InputObject $states -Compress
`;

type WindowsRequest = { directory: string; paths: string[]; done: (result: PinResult) => void; reject: (error: unknown) => void };
let windowsPending: WindowsRequest[] = [];
let windowsTimer: ReturnType<typeof setTimeout> | undefined;

async function flushWindowsPins() {
  const requests = windowsPending;
  windowsPending = [];
  windowsTimer = undefined;
  try {
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = await run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")],
      JSON.stringify(requests.map(({ directory, paths }) => ({ directory, paths }))));
    const results: unknown = JSON.parse(output);
    if (!Array.isArray(results) || results.length !== requests.length || !results.every(result => ["requested", "unsupported", "failed"].includes(result))) {
      throw new Error("Unexpected Cloud Files pin response");
    }
    for (const [index, result] of results.entries()) {
      if (result === "failed") requests[index].reject(new Error("Cloud Files pin request failed"));
      else requests[index].done(result);
    }
  } catch (error) {
    for (const request of requests) request.reject(error);
  }
}

export async function requestWindowsFolderPin(directory: string): Promise<PinResult> {
  const paths = await entries(directory);
  return new Promise((done, reject) => {
    windowsPending.push({ directory, paths, done, reject });
    // Startup projects share one compiler/process instead of launching one
    // PowerShell/C# compiler for every folder simultaneously.
    windowsTimer ??= setTimeout(() => { void flushWindowsPins(); }, 10);
  });
}

/** Requests persistent offline availability, not sync exclusion. Downloading
 * remains asynchronous and provider-owned; a successful request is not proof
 * that every descendant is already resident. Failures do not fail startup. */
export async function keepProjectStateDownloaded(root: string): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  await Promise.all([".opencode", ".legalwork"].map(async name => {
    const directory = join(resolve(root), name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const identity = `${info.dev}:${info.ino}`;
      const previous = attempts.get(directory);
      if (previous?.identity === identity && previous.expires > Date.now()) return await previous.work;
      const work = (async () => {
        const result = process.platform === "darwin" ? await pinMac(directory) : await requestWindowsFolderPin(directory);
        if (result === "unsupported") {
          if (process.platform === "darwin" && await isCloudFolder(directory)) throw new Error("Storage client does not expose a supported offline pin");
        } else {
          console.info(`[project-availability] Keep Downloaded requested for ${directory}`);
          const attempt = attempts.get(directory);
          if (attempt?.identity === identity) attempt.expires = Infinity;
        }
        warnings.delete(directory);
      })();
      // Retry unsuccessful requests later. Acknowledged pins persist; do not
      // rewrite every helper attribute on each project metadata refresh.
      attempts.set(directory, { identity, expires: Date.now() + 60_000, work });
      await work;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      if (!warnings.has(directory)) {
        warnings.add(directory);
        console.warn(`[project-availability] Could not request Keep Downloaded for ${directory}; use the storage client's offline option. Project access will continue.`);
      }
    }
  }));
}
