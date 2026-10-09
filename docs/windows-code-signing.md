# Windows code signing

LegalWork's x64 and ARM64 NSIS installers are signed through SignPath from
GitHub-hosted runners. The signed installer replaces the unsigned installer
before regenerating its blockmap and updater SHA-512/size metadata. Release
checksums are generated from the final signed bytes. This integration signs
the installer; it does not separately sign the installed application,
uninstaller, or bundled third-party binaries.

## SignPath account

- Organization: `LegalWork [OSS]`, ID `2fbfaf77-75ec-4655-a68c-ab1a8397d4f1`.
- Project: `legalwork`, linked to `https://github.com/eigenweltlabs/legalwork.git`.
- Trusted build system: `GitHub.com`.
- Artifact configuration: `windows-installer`. Its XML is maintained in
  [`scripts/release/signpath-windows-installer.xml`](../scripts/release/signpath-windows-installer.xml).
  GitHub uploads a ZIP containing exactly one installer per architecture.
  Requests supply the stamped package version and architecture. SignPath
  requires that filename and PE product metadata match those values.
- CI user: `CI builds`, a submitter for `test-signing` and `release-signing`.
- The initial test certificate is self-signed. Its SHA-1 thumbprint is
  `8D1A630DC86683F8A02A86594E8D3E6A3547A7D6`. It is never installed as a trusted root.

SignPath Foundation approved the project on October 8, 2026. The production
certificate is pending. Their onboarding process requires a successful test
and review of the GitHub integration before they issue it.

## First integration test

1. Confirm the CI user's notification address using the SignPath email.
2. In SignPath, open **Users and Groups → CI builds**. If the generated API
   token was not saved, regenerate it manually. Store it as the repository
   Actions secret `SIGNPATH_API_TOKEN` in `eigenweltlabs/legalwork`. Do not put
   it in a repository variable, source file, PR, or chat message.
3. Set repository variable `SIGNPATH_ORGANIZATION_ID` to the organization ID above.
4. Dispatch **Alpha Channel (Windows x64 + ARM64)** with `signing_test=true`:

   ```sh
   gh workflow run alpha-windows-x64.yml --ref <integration-branch> -f signing_test=true
   ```

   This forces `test-signing` and `windows-installer`, verifies the expected
   test signer, signature status, and timestamp, regenerates updater metadata,
   and stores the resulting installers as `signpath-test-windows-x64` and
   `signpath-test-windows-arm64` workflow artifacts for seven days. It does not
   create a GitHub release or change the alpha updater pointer.
5. Give SignPath support the successful GitHub run and signing-request links
   so they can verify origin metadata and issue the production certificate.
   Check their requested GitHub App permissions if installation is required
   for audit-policy evaluation; restrict any installation to this repository.

Do not distribute test-signed installers as trusted releases. They do not
remove Windows certificate trust warnings.

## Enable production signing

After SignPath imports the production certificate and the `release-signing`
policy is valid, configure these repository Actions variables:

| Variable | Value |
| --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | `2fbfaf77-75ec-4655-a68c-ab1a8397d4f1` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |
| `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | `windows-installer` |
| `SIGNPATH_PROJECT_SLUG` | `legalwork` |

Set the project slug last: it activates signing in both stable and alpha
workflows. Prefer variables for these public identifiers; existing secrets
of the same name take precedence. Keep the API token in `SIGNPATH_API_TOKEN`.
Once enabled, incomplete configuration or signing failures stop publication.
Public builds require the `release-signing` policy and a Windows-trusted,
timestamped Authenticode signature. Test signing is restricted to the explicit
test mode.

The production policy requires GitHub origin verification and one approval
from Johann Frederik Machemer. Approve production signing requests in
SignPath; the workflow waits up to one hour for the signed result.
GitHub draft-release publication remains a separate release approval step.

## Verification

```sh
node --test scripts/release/*.test.mjs
actionlint -shellcheck= .github/workflows/alpha-windows-x64.yml .github/workflows/release-macos-aarch64.yml
```

The Authenticode checks run on Windows in CI. To repeat them there:

```powershell
./scripts/release/verify-windows-signature.ps1 -ArtifactDirectory <signed-artifact-directory>
```

References: [SignPath GitHub integration](https://docs.signpath.io/trusted-build-systems/github),
[artifact configuration syntax](https://docs.signpath.io/artifact-configuration/syntax).
