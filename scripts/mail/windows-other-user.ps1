# Ephemeral hosted-runner qualification only. Never invoked by the desktop runtime.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Ephemeral GitHub Actions runner required' }
$account = 'mailq' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$password = [Guid]::NewGuid().ToString('N') + 'aA!7'
$created = $false
$control = Join-Path $env:PUBLIC ($account + '.txt')
try {
  $value = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [System.IO.File]::WriteAllText($control, 'synthetic-readable-control')
  $controlAcl = Get-Acl -LiteralPath $control
  $readRule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]'S-1-5-11', [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
  $controlAcl.AddAccessRule($readRule); Set-Acl -LiteralPath $control -AclObject $controlAcl
  $inputValue = @{path=$value.path;control=$control} | ConvertTo-Json -Compress
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  New-LocalUser -Name $account -Password $secure -AccountNeverExpires | Out-Null
  $created = $true
  $program = @'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $controlRead = $false
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ([System.IO.File]::ReadAllText($data.control) -ne 'synthetic-readable-control') { [Console]::Out.Write('control_failed'); exit 1 }
  $controlRead = $true
  [System.IO.File]::ReadAllBytes($data.path) | Out-Null
  [Console]::Out.Write('readable'); exit 1
} catch [System.UnauthorizedAccessException] { if (!$controlRead) { exit 1 }; [Console]::Out.Write('denied'); exit 0 }
catch { [Console]::Out.Write('failed'); exit 1 }
'@
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
  $info.UserName = $account; $info.Domain = $env:COMPUTERNAME; $info.Password = $secure
  $info.UseShellExecute = $false; $info.LoadUserProfile = $true
  $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.CreateNoWindow = $true
  $child = New-Object System.Diagnostics.Process; $child.StartInfo = $info
  if (!$child.Start()) { throw 'start' }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputValue)
  $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $child.StandardInput.BaseStream.Flush(); $child.StandardInput.Close()
  if (!$child.WaitForExit(20000)) { $child.Kill(); throw 'timeout' }
  if ($child.ExitCode -ne 0 -or $child.StandardOutput.ReadToEnd() -ne 'denied') { throw 'isolation' }
  [Console]::Out.WriteLine('mail_other_os_user_denied')
} catch { [Console]::Error.WriteLine('mail_other_user_qualification_failed'); exit 1 }
finally { Remove-Item -LiteralPath $control -Force -ErrorAction SilentlyContinue; if ($created) { Remove-LocalUser -Name $account } }
