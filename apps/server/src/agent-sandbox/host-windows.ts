/** The wrapper assigns itself to a kill-on-close job before evaluating user
 * code. Windows then reaps descendants even if the shell exits first. */
export function windowsHostScript(command: string): string {
  // Capture $? in the command's own scope. Windows PowerShell resets it when a
  // script block returns, including after a non-terminating Write-Error.
  const exitStatus = `
$succeeded = $?
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
if (-not $succeeded) { exit 1 }
`;
  const source = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LegalWorkCommandJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
    public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref Extended limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static void Attach() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new Extended(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended))) || !AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    // Keep the handle open until process exit; it must not be inherited by children.
  }
}
'@
[LegalWorkCommandJob]::Attach()
$ErrorActionPreference = 'Continue'
& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command + "\n" + exitStatus).toString("base64")}'))))
${exitStatus}
`;
  return source;
}
