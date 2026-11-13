param(
    [Parameter(Mandatory = $true)][string]$ArtifactDirectory,
    [Parameter(Mandatory = $true)][string]$AppExecutable
)

$ErrorActionPreference = "Stop"
$expectedPublisher = "Eigenwelt Labs UG (haftungsbeschränkt)"
$installers = @(Get-ChildItem -LiteralPath $ArtifactDirectory -File |
    Where-Object { $_.Name -match '^legalwork-win-(x64|arm64)-.+\.exe$' })
if ($installers.Count -ne 1) { throw "Expected exactly one signed Windows installer, found $($installers.Count)." }

foreach ($file in @($installers[0].FullName, $AppExecutable)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne "Valid") {
        throw "Windows signature is not trusted for ${file}: $($signature.Status): $($signature.StatusMessage)"
    }
    if (!$signature.SignerCertificate) { throw "No signing certificate for ${file}." }
    if (!$signature.TimeStamperCertificate) { throw "No Authenticode timestamp for ${file}." }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($publisher -cne $expectedPublisher) { throw "Unexpected publisher for ${file}: $publisher" }

    $report = "Verified ${file}: $($signature.Status); signer $($signature.SignerCertificate.Subject); thumbprint $($signature.SignerCertificate.Thumbprint)."
    Write-Output $report
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $report }
}

# Change a reserved DOS-header byte in a disposable copy, preserving PE structure.
# Windows must detect changed signed bytes even when the original chain is trusted.
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
        throw "Tampered installer was not rejected with HashMismatch: $($tamperedSignature.Status): $($tamperedSignature.StatusMessage)"
    }
    Write-Output "Verified tamper detection: modified installer rejected with HashMismatch."
} finally { Remove-Item -LiteralPath $tamperedInstaller -ErrorAction SilentlyContinue }
