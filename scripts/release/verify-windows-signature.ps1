param([Parameter(Mandatory = $true)][string]$ArtifactDirectory)

$ErrorActionPreference = "Stop"
$installers = @(Get-ChildItem -LiteralPath $ArtifactDirectory -Recurse -File |
    Where-Object { $_.Name -match '^legalwork-win-(x64|arm64)-.+\.exe$' })
if ($installers.Count -ne 1) { throw "Expected exactly one signed Windows installer, found $($installers.Count)." }

$signature = Get-AuthenticodeSignature -LiteralPath $installers[0].FullName
if (!$signature.SignerCertificate) { throw "Windows installer has no signing certificate." }
if (!$signature.TimeStamperCertificate) { throw "Windows installer has no Authenticode timestamp." }

if ($env:SIGNPATH_TEST -eq "true") {
    # Only this specific test certificate may have an untrusted chain. Never
    # install it as a trusted root on the runner or on a user's machine.
    if ($signature.SignerCertificate.Thumbprint -ne "8D1A630DC86683F8A02A86594E8D3E6A3547A7D6") {
        throw "Installer was not signed by LegalWork's SignPath test certificate."
    }
    # PowerShell maps CERT_E_UNTRUSTEDROOT (0x800B0109) to UnknownError.
    # Compare the localized Win32 message, accepting only this specific error;
    # explicit distrust, digest errors, and other UnknownError results still fail.
    $untrustedRootMessage = [System.ComponentModel.Win32Exception]::new(-2146762487).Message
    $isUntrustedRoot = $signature.Status -eq "UnknownError" -and $signature.StatusMessage -eq $untrustedRootMessage
    if ($signature.Status -ne "Valid" -and !$isUntrustedRoot) {
        throw "Invalid test signature: $($signature.Status): $($signature.StatusMessage)"
    }

    # Confirm Windows detects a modified signed byte even with an untrusted
    # test chain. Change a reserved DOS-header byte, preserving PE structure.
    $tamperedInstaller = Join-Path ([System.IO.Path]::GetTempPath()) ("legalwork-signature-tamper-$([guid]::NewGuid()).exe")
    try {
        Copy-Item -LiteralPath $installers[0].FullName -Destination $tamperedInstaller
        $stream = [System.IO.File]::Open($tamperedInstaller, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
        try {
            $stream.Position = 0x20
            $originalByte = $stream.ReadByte()
            $stream.Position = 0x20
            $stream.WriteByte([byte]($originalByte -bxor 1))
        } finally { $stream.Dispose() }
        $tamperedSignature = Get-AuthenticodeSignature -LiteralPath $tamperedInstaller
        if ($tamperedSignature.Status -ne "HashMismatch") {
            throw "Tampered test installer was not rejected with HashMismatch: $($tamperedSignature.Status): $($tamperedSignature.StatusMessage)"
        }
        Write-Output "Verified tamper detection: modified installer rejected with HashMismatch."
    } finally { Remove-Item -LiteralPath $tamperedInstaller -ErrorAction SilentlyContinue }
} elseif ($signature.Status -ne "Valid") {
    throw "Windows installer signature is not trusted: $($signature.Status): $($signature.StatusMessage)"
}

$report = "Verified $($installers[0].Name): $($signature.Status); signer $($signature.SignerCertificate.Subject); thumbprint $($signature.SignerCertificate.Thumbprint)."
Write-Output $report
if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $report }
