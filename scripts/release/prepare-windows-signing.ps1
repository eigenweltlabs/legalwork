param([ValidateRange(0, 30)][int]$RetryDelaySeconds = 5)

$ErrorActionPreference = 'Stop'
$version = '0.5.8'
$powershell = Join-Path $PSHOME $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' })

# electron-builder's installation can return without making the cmdlet available.
# Verify discovery in the same fresh, profile-free process used by its signer.
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        $installed = Get-Module -ListAvailable -Name TrustedSigning |
            Where-Object { $_.Version -eq [version]$version }
        if ($attempt -gt 1 -or -not $installed) {
            Install-Module -Name TrustedSigning -RequiredVersion $version -Repository PSGallery -Scope CurrentUser -Force -ErrorAction Stop
        }
        & $powershell -NoProfile -NonInteractive -Command @'
$ErrorActionPreference = 'Stop'
Import-Module TrustedSigning -RequiredVersion 0.5.8 -Force -ErrorAction Stop
$command = Get-Command Invoke-TrustedSigning -Module TrustedSigning -ErrorAction Stop
if ($command.Module.Version -ne [version]'0.5.8') { throw 'Unexpected TrustedSigning module version' }
Write-Host 'Verified TrustedSigning 0.5.8 in a fresh PowerShell process.'
'@
        if ($LASTEXITCODE -ne 0) { throw 'TrustedSigning is unavailable to a fresh signing process' }
        return
    } catch {
        if ($attempt -eq 3) { throw }
        Write-Warning "Signing module preparation attempt $attempt failed: $($_.Exception.Message)"
        Start-Sleep -Seconds $RetryDelaySeconds
    }
}
