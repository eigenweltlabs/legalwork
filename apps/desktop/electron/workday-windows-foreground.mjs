import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Resolve the input-focused window inside the foreground frame, including a
// hosted app whose focus belongs to a different process. Read process identity
// only. GUI thread information contains handles, not the contents of controls.
const probeScript = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkdayFocus {
  [StructLayout(LayoutKind.Sequential)]
  public struct GuiThread {
    public int size, flags;
    public IntPtr active, focus, capture, menu, move, caret;
    public int left, top, right, bottom;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThread gui);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  public static uint ProcessForWindow(IntPtr frame) {
    uint process;
    uint thread = GetWindowThreadProcessId(frame, out process);
    if (thread == 0) return 0;
    GuiThread gui = new GuiThread();
    gui.size = Marshal.SizeOf(typeof(GuiThread));
    if (GetGUIThreadInfo(thread, ref gui) && gui.focus != IntPtr.Zero &&
        GetAncestor(gui.focus, 2) == frame) {
      uint focused;
      if (GetWindowThreadProcessId(gui.focus, out focused) != 0) return focused;
    }
    return process;
  }
}
'@
while (($command = [Console]::ReadLine()) -eq 'sample') {
  $sample = @{}
  try {
    $frame = [WorkdayFocus]::GetForegroundWindow()
    if ($frame -ne [IntPtr]::Zero) {
      $processId = [WorkdayFocus]::ProcessForWindow($frame)
      if ($processId -gt 0) {
        $process = [Diagnostics.Process]::GetProcessById($processId)
        try { $appName = $process.ProcessName } finally { $process.Dispose() }
        if ([WorkdayFocus]::GetForegroundWindow() -eq $frame) {
          if ($appName -in @('LockApp', 'LogonUI')) { $sample = @{ locked = $true } }
          else { $sample = @{ application = $appName; pid = $processId } }
        }
      }
    }
  } catch {}
  [Console]::WriteLine((ConvertTo-Json -Compress $sample))
}
`;

// The child sleeps on stdin between requests. Reuse it to avoid starting the
// CLR for every sample, and retire it if the source is disabled or goes idle.
export function createWindowsForegroundReader(executable, spawnProcess = spawn) {
  let child;
  let waiting;
  let expiry;
  function close() {
    clearTimeout(expiry);
    const previous = child;
    child = undefined;
    previous?.kill();
    waiting?.(undefined);
  }
  function start() {
    const worker = spawnProcess(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probeScript], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    child = worker;
    const lost = () => { if (child === worker) close(); };
    worker.once("exit", lost);
    worker.once("error", lost);
    worker.stdin.on("error", lost);
    const lines = createInterface({ input: worker.stdout });
    lines.on("line", line => {
      if (child !== worker || !waiting) return;
      try { waiting(line.length <= 1024 ? JSON.parse(line) : undefined); }
      catch { waiting(undefined); }
    });
    return worker;
  }
  return { close, read() {
    if (waiting) return Promise.resolve(undefined);
    const worker = child ?? start();
    clearTimeout(expiry);
    return new Promise(resolve => {
      const timeout = setTimeout(close, 4_000);
      waiting = result => {
        clearTimeout(timeout);
        waiting = undefined;
        if (child) {
          expiry = setTimeout(close, 35_000);
          expiry.unref?.();
        }
        resolve(result);
      };
      worker.stdin.write("sample\n");
    });
  } };
}
