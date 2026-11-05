# Unit-test fixture: substitute Authenticode results, keeping real file and
# tamper-copy handling. Packaged builds call the real Windows cmdlet separately.
param([Parameter(Mandatory = $true)][string]$Scenario)
$ErrorActionPreference = "Stop"
$env:GITHUB_STEP_SUMMARY = $null
$directory = Join-Path ([System.IO.Path]::GetTempPath()) ("legalwork signature test $([guid]::NewGuid())")
New-Item -ItemType Directory -Path $directory | Out-Null
$installer = Join-Path $directory "legalwork-win-x64-1.0.0.exe"
$app = Join-Path $directory "LegalWork.exe"
$bytes = [byte[]]::new(64)
[System.IO.File]::WriteAllBytes($installer, $bytes)
[System.IO.File]::WriteAllBytes($app, $bytes)
if ($Scenario -eq "no-installer") { Remove-Item -LiteralPath $installer }
if ($Scenario -eq "multiple-installers") { Copy-Item -LiteralPath $installer -Destination (Join-Path $directory "legalwork-win-arm64-1.0.0.exe") }

function Get-AuthenticodeSignature([string]$LiteralPath) {
    if ((Split-Path $LiteralPath -Leaf) -like "legalwork-signature-tamper-*") {
        if ([System.IO.File]::ReadAllBytes($LiteralPath)[0x20] -ne 1) { throw "Tamper copy was not modified." }
        $script:tamperCopy = $LiteralPath
        return [pscustomobject]@{ Status = $(if ($Scenario -eq "undetected-tamper") { "Valid" } else { "HashMismatch" }) }
    }
    $isApp = $LiteralPath -eq $app
    $status = "Valid"
    if (($Scenario -eq "unsigned-installer" -and !$isApp) -or ($Scenario -eq "unsigned-app" -and $isApp)) { $status = "NotSigned" }
    if ($Scenario -eq "untrusted-installer") { $status = "UnknownError" }
    $certificate = [pscustomobject]@{ Subject = "CN=Eigenwelt Labs UG (haftungsbeschränkt)"; Thumbprint = "test-fixture" }
    $certificate | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value {
        param($NameType, $ForIssuer)
        if ($Scenario -eq "wrong-publisher") { return "Another Publisher" }
        return "Eigenwelt Labs UG (haftungsbeschränkt)"
    }
    if ($Scenario -eq "missing-certificate") { $certificate = $null }
    $timestamp = [pscustomobject]@{ Subject = "Timestamp fixture" }
    if ($Scenario -eq "missing-timestamp" -or ($Scenario -eq "app-missing-timestamp" -and $isApp)) { $timestamp = $null }
    return [pscustomobject]@{ Status = $status; SignerCertificate = $certificate; TimeStamperCertificate = $timestamp }
}

try {
    & (Join-Path $PSScriptRoot "verify-windows-signature.ps1") -ArtifactDirectory $directory -AppExecutable $app
} finally {
    if ($script:tamperCopy -and (Test-Path -LiteralPath $script:tamperCopy)) { throw "Verification left a tamper copy behind." }
    if ((Test-Path -LiteralPath $installer) -and [System.IO.File]::ReadAllBytes($installer)[0x20] -ne 0) { throw "Verification modified the original installer." }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
