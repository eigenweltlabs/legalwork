# Ephemeral hosted-runner qualification only. Never invoked by the desktop runtime.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Ephemeral GitHub Actions runner required' }
$account = 'mailq' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$password = [Guid]::NewGuid().ToString('N') + 'aA!7'
$created = $false
$stage = 'control'
function Phase([string]$name) { [Console]::Error.WriteLine('mail_other_user_phase=' + $name) }
$control = Join-Path $env:PUBLIC ($account + '.txt')
try {
  Phase 'control'
  $value = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [System.IO.File]::WriteAllText($control, 'synthetic-readable-control')
  $controlAcl = Get-Acl -LiteralPath $control
  $readRule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]'S-1-5-11', [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
  $controlAcl.AddAccessRule($readRule); Set-Acl -LiteralPath $control -AclObject $controlAcl
  $inputValue = @{path=$value.path;control=$control} | ConvertTo-Json -Compress
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  $stage = 'create-user'; Phase $stage
  $localUser = New-LocalUser -Name $account -Password $secure -AccountNeverExpires
  $created = $true
  $users = Get-LocalGroup -SID 'S-1-5-32-545'
  if (!(@(Get-LocalGroupMember -Group $users | Where-Object { $_.SID -eq $localUser.SID }).Count)) { Add-LocalGroupMember -Group $users -Member $localUser }
  $program = @'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  [Console]::Error.WriteLine('child_phase=started')
  $controlRead = $false
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [Console]::Error.WriteLine('child_phase=input-read')
  if ([System.IO.File]::ReadAllText($data.control) -ne 'synthetic-readable-control') { [Console]::Out.Write('control_failed'); exit 1 }
  $controlRead = $true
  [Console]::Error.WriteLine('child_phase=control-read')
  [System.IO.File]::ReadAllBytes($data.path) | Out-Null
  [Console]::Out.Write('readable'); exit 1
} catch [System.UnauthorizedAccessException] { if (!$controlRead) { exit 1 }; [Console]::Out.Write('denied'); exit 0 }
catch { [Console]::Error.WriteLine('child_exception=' + $_.Exception.GetType().Name); if ($_.Exception.InnerException) { [Console]::Error.WriteLine('child_inner_exception=' + $_.Exception.InnerException.GetType().Name) }; [Console]::Out.Write('failed'); exit 1 }
'@
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
  $info.UserName = $account; $info.Domain = $env:COMPUTERNAME; $info.Password = $secure
  $info.UseShellExecute = $false; $info.LoadUserProfile = $true
  $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.CreateNoWindow = $true
  $child = New-Object System.Diagnostics.Process; $child.StartInfo = $info
  $stage = 'start-other-user'; Phase $stage
  if (!$child.Start()) { throw 'start' }
  Phase 'child-started'
  # Diagnostic variant drains both redirected pipes before waiting; baseline stays untouched.
  $stdoutTask = $child.StandardOutput.ReadToEndAsync()
  $stderrTask = $child.StandardError.ReadToEndAsync()
  $stage = 'input'; Phase $stage
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputValue)
  $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $child.StandardInput.BaseStream.Flush(); $child.StandardInput.Close()
  Phase 'input-closed'
  $stage = 'wait'; Phase $stage
  $exited = $child.WaitForExit(20000)
  if (!$exited) { Phase 'timeout'; $child.Kill(); $null = $child.WaitForExit(5000) }
  if (!$stdoutTask.Wait(5000) -or !$stderrTask.Wait(5000)) { throw 'pipe-timeout' }
  $out = $stdoutTask.Result; $err = $stderrTask.Result
  [Console]::Error.WriteLine(('child_exit={0} stdout_chars={1} stderr_chars={2}' -f $child.ExitCode, $out.Length, $err.Length))
  foreach ($match in [regex]::Matches($err, '(?m)^(child_phase|child_exception|child_inner_exception)=[A-Za-z0-9_-]+')) { [Console]::Error.WriteLine($match.Value) }
  $stage = 'verify-denial'; Phase $stage
  if (!$exited) { throw 'timeout' }
  if ($child.ExitCode -ne 0 -or $out -ne 'denied') { throw 'isolation' }
  [Console]::Out.WriteLine('mail_other_os_user_denied')
} catch { [Console]::Error.WriteLine(('mail_other_user_qualification_failed stage={0} exception={1}' -f $stage, $_.Exception.GetType().Name)); exit 1 }
finally { Remove-Item -LiteralPath $control -Force -ErrorAction SilentlyContinue; if ($created) { Remove-LocalUser -Name $account } }
