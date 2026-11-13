# Windows code signing

The stable and alpha workflows sign Windows x64 and ARM64 builds with
Microsoft Azure Artifact Signing. The CI-only
[`electron-builder.azure.yml`](../apps/desktop/electron-builder.azure.yml)
overlay uses Electron Builder 26's native `win.azureSignOptions` integration.
It signs the app and selected bundled executables, the NSIS uninstaller, and
the installer before blockmaps and updater metadata are generated. Signing
is mandatory in CI; local packaging still uses `electron-builder.yml`.

The packaged `opencode.exe` is excluded from re-signing. Its exact bytes are
independently pinned by the engine distribution manifest and verified during
packaging and startup. Authenticode changes those bytes, so re-signing it would
invalidate the engine's integrity checks. This internal executable retains its
producer's bytes and signing state; the app, installer, uninstaller and other
selected bundled executables still use Azure signing. Signing the engine itself
would need to happen before generating the distribution's hashes and provenance.

## Company resources

| Setting | Value |
| --- | --- |
| Tenant | `e2fd8f91-6a4c-4705-a16b-10383242a69a` |
| Subscription | `85e54d85-5b74-472a-85d3-84eae7fd0ffc` |
| Resource group | `rg-legalwork-signing` |
| Signing account | `eigenweltlabslegalwork` |
| Certificate profile | `legalwork` (PublicTrust) |
| Endpoint | `https://neu.codesigning.azure.net/` |
| Publisher | `Eigenwelt Labs UG (haftungsbeschränkt)` |
| CI application | `LegalWork GitHub Signing` |
| CI client ID | `2691255f-2047-4b7c-9202-d09b43951b6f` |

These are public resource identifiers, not login credentials.

## Authentication and automatic signing

The GitHub environment **windows-signing** holds `AZURE_CLIENT_ID` and
`AZURE_TENANT_ID`. `azure/login@v2` requests a GitHub OIDC token immediately
after the build and before packaging. The signing module uses the resulting
Azure CLI login. No subscription selection is needed for the signing data
endpoint; `AZURE_SUBSCRIPTION_ID` is retained in the environment for account
administration but is not required by packaging.

Azure trusts only this federation:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:eigenweltlabs/legalwork:environment:windows-signing`
- Audience: `api://AzureADTokenExchange`

The service principal has **Artifact Signing Certificate Profile Signer**
scoped to `eigenweltlabslegalwork/certificateProfiles/legalwork`, without
subscription-wide administration or identity-validation permissions. The
GitHub environment allows only the `dev` branch and `v*` tags. It has no
required reviewer or waiting period, as signing is automatic. Changes to
these environment rules or workflows should receive maintainer review.

Windows signing jobs alone receive `id-token: write`. Stable macOS and Linux
packaging use a separate job without the signing environment. SignPath
configuration and API tokens are no longer used by these workflows; the
legacy SignPath scripts remain for historical builds.

## Verification and the first real signing test

Local checks:

```sh
node --test scripts/release/*.test.mjs scripts/ci/*.test.mjs
actionlint -shellcheck= .github/workflows/alpha-windows-x64.yml .github/workflows/release-macos-aarch64.yml .github/workflows/ci-tests.yml
```

`windows-signing.test.mjs` validates the overlay with the installed packager,
checks the workflow signing/publication gates, and tests the verifier with
substituted Authenticode results. The verifier tests require PowerShell;
they run on Windows PR CI, or locally with `PWSH_PATH=/path/to/pwsh`.
These unit tests do not prove Azure can sign an actual installer.

A PR branch cannot use the signing environment. After the change is reviewed
and merged into `dev`, run a real signing test without publication:

```sh
gh workflow run alpha-windows-x64.yml --ref dev -f signing_test=true
```

This builds both architectures, uses the production public-trust profile,
checks the real Windows Authenticode results and packaged startup, and stores
`azure-signing-test-windows-x64` and `azure-signing-test-windows-arm64`
workflow artifacts for seven days. It creates no GitHub release and does not
change the updater feed. Do not create a `v*` tag to test signing; that starts
the stable release workflow. A merge to `dev` also triggers the normal alpha
workflow, which retains its existing automatic publication behavior.

The real verifier requires exactly one architecture-specific installer and
checks both it and the unpacked `LegalWork.exe` for:

- Windows signature status `Valid`;
- an Authenticode timestamp;
- certificate common name `Eigenwelt Labs UG (haftungsbeschränkt)`;
- rejection of modified installer bytes with `HashMismatch`.

It does not pin the short-lived certificate thumbprint, which rotates.
To repeat verification on a Windows machine after downloading the build:

```powershell
./scripts/release/verify-windows-signature.ps1 -ArtifactDirectory apps/desktop/dist-electron -AppExecutable apps/desktop/dist-electron/win-unpacked/LegalWork.exe
```

For ARM64, use `win-arm64-unpacked/LegalWork.exe`. Before the first public
rollout, install the matching smoke-test installer on a clean Windows machine,
confirm the publisher in installer properties/UAC, launch LegalWork and check
uninstallation. The unpacked app is checked on the runner and is not included
in the downloadable smoke-test artifact. The installed uninstaller is signed
by Electron Builder but is not separately extracted for the CI verifier.

Signing establishes publisher identity; Microsoft Defender SmartScreen can
still show reputation warnings for new downloads.

## Publication

A failed signing or signature check blocks asset upload for that architecture.
Stable updater-manifest publication and the final release-ready job also
require the Windows signing matrix to succeed. Stable releases remain drafts
for a separate manual publication. Alpha publication remains automatic unless
`signing_test=true` is selected.

References: [Artifact Signing GitHub OIDC setup](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md),
[Artifact Signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles),
[Electron Builder Windows signing](https://github.com/electron-userland/electron-builder/blob/v26.16.1/packages/app-builder-lib/src/codeSign/windowsSignAzureManager.ts).
