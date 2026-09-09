import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

// Fixed program: paths are JSON over stdin, never PowerShell source or command arguments.
// .NET Framework API: https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity
export const MAIL_WINDOWS_ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = [string]$inputValue.path
  $directory = [bool]$inputValue.directory
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $target -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'unsafe' }
  $acl = Get-Acl -LiteralPath $target
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
  if ($owner -ne $sid.Value -and !($owner -eq 'S-1-5-32-544' -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))) { throw 'owner' }
  if ($directory) { $replacement = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $replacement = New-Object System.Security.AccessControl.FileSecurity }
  $replacement.SetOwner($sid)
  $replacement.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($directory) { $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $replacement.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $replacement
  $checked = Get-Acl -LiteralPath $target
  if (!$checked.AreAccessRulesProtected -or $checked.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'verify' }
  $rules = @($checked.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { throw 'rules' }
  $allowed = $rules[0]
  if ($allowed.IdentityReference.Value -ne $sid.Value -or $allowed.AccessControlType -ne 'Allow' -or $allowed.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $allowed.InheritanceFlags -ne $inheritance) { throw 'rights' }
  [Console]::Out.Write('ok')
} catch { [Console]::Out.Write('failed'); exit 1 }
`;

/** Owner-only protected DACL, inheritable for new SQLite sidecars. No credential input. */
export async function enforceMailWindowsAcl(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  if (!isAbsolute(path) || path.includes("\0") || path.length > 32700 || typeof directory !== "boolean") throw new Error("mail_permissions_unsafe");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("mail_permissions_unsafe");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(MAIL_WINDOWS_ACL_PROGRAM, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, WINDIR: systemRoot } });
    let output = "", failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 10000);
    child.stdout.on("data", bytes => { if (output.length <= 32) output += bytes.toString(); if (output.length > 32) { failed = true; child.kill(); } });
    child.stderr.resume();
    child.on("error", () => { failed = true; });
    child.stdin.on("error", () => { failed = true; child.kill(); });
    child.on("close", code => { clearTimeout(timer); if (!failed && code === 0 && output === "ok") resolve(); else reject(new Error("mail_permissions_unsafe")); });
    child.stdin.end(JSON.stringify({ path, directory }));
  });
}
