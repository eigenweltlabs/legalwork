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
    if ($signature.Status -notin @("Valid", "NotTrusted")) {
        throw "Invalid test signature: $($signature.Status): $($signature.StatusMessage)"
    }
} elseif ($signature.Status -ne "Valid") {
    throw "Windows installer signature is not trusted: $($signature.Status): $($signature.StatusMessage)"
}

$report = "Verified $($installers[0].Name): $($signature.Status); signer $($signature.SignerCertificate.Subject); thumbprint $($signature.SignerCertificate.Thumbprint)."
Write-Output $report
if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $report }
