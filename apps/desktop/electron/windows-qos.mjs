/**
 * Windows 11 EcoQoS / power-throttling opt-out.
 *
 * A window-owning process drops to Low QoS (E-cores, minimum frequency) when
 * minimized or fully occluded on battery, users can force Efficiency mode on
 * any process from Task Manager, and Windows stops honoring high-resolution
 * timers for invisible processes. All of that lands on hotkey-to-capture
 * latency and transcription speed exactly in the background scenario
 * dictation lives in. Electron has no API for the opt-out
 * (SetProcessInformation ProcessPowerThrottling), so a one-shot PowerShell
 * helper pins the given PIDs to HighQoS with high-resolution timers kept.
 *
 * Best-effort by design: on hosts where PowerShell is locked down
 * (Constrained Language Mode) or before Windows 11 22H2 this silently does
 * nothing, and the app keeps working with OS-managed QoS.
 */

import { spawn } from "node:child_process";

function buildScript(pids) {
  return String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;

public static class LegalWorkQoS {
  [StructLayout(LayoutKind.Sequential)]
  public struct PowerThrottlingState {
    public uint Version;
    public uint ControlMask;
    public uint StateMask;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetProcessInformation(IntPtr process, int informationClass, ref PowerThrottlingState state, uint size);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

  public static void Pin(uint pid) {
    IntPtr handle = OpenProcess(0x0200 /* PROCESS_SET_INFORMATION */, false, pid);
    if (handle == IntPtr.Zero) return;
    PowerThrottlingState state = new PowerThrottlingState();
    state.Version = 1; // PROCESS_POWER_THROTTLING_CURRENT_VERSION
    // EXECUTION_SPEED (never EcoQoS) | IGNORE_TIMER_RESOLUTION (keep hi-res timers)
    state.ControlMask = 0x1 | 0x4;
    state.StateMask = 0;
    SetProcessInformation(handle, 4 /* ProcessPowerThrottling */, ref state, (uint)Marshal.SizeOf(typeof(PowerThrottlingState)));
    CloseHandle(handle);
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
${pids.map((pid) => `[LegalWorkQoS]::Pin(${pid})`).join("\n")}
`;
}

/**
 * Fire-and-forget HighQoS pin for the given process ids (win32 only).
 * @param {number[]} pids
 */
export function pinWindowsProcessQoS(pids) {
  if (process.platform !== "win32") return;
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (valid.length === 0) return;
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", buildScript(valid)],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => {});
    child.unref();
  } catch {
    // QoS pinning is an optimization, never a startup dependency.
  }
}
