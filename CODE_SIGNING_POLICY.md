# Code signing policy

LegalWork's Windows builds use Microsoft Azure Artifact Signing with the
public-trust certificate profile owned by Eigenwelt Labs UG
(haftungsbeschränkt).

Authors and reviewers are repository maintainers
[Johann Machemer](https://github.com/johannmachemer) and
[Christian-Hauke Poensgen](https://github.com/christianhpoe).
Contributions from others require maintainer review.

Signing runs automatically on GitHub-hosted Windows runners for the protected
`windows-signing` environment. Its deployment rules allow the `dev` branch
and `v*` tags. GitHub OpenID Connect grants a short-lived Azure identity with
signing access to the `legalwork` certificate profile only. No certificate
private key or long-lived Azure client secret is stored in GitHub.

Electron Builder signs the packaged application, selected bundled executable
files, NSIS uninstaller and installer during packaging. The workflow requires
trusted, timestamped signatures from Eigenwelt Labs on the application and
installer, and checks that a modified installer is rejected. Updater metadata
and checksums are generated from the final signed files. A signing or
verification failure stops the affected build before its assets are uploaded.

Signing requires no per-build manual approval. Stable releases are built as
GitHub drafts and published manually; alpha releases retain their existing
automatic publication flow. The explicit signing smoke-test mode only uploads
workflow artifacts and does not publish a release.

See the [LegalWork privacy notice](https://eigenweltlabs.com/legalwork/privacy)
and [TERMS.md](TERMS.md) for local processing, model-provider and connector
transmissions, and optional analytics. Connected providers' privacy terms
apply to content sent to those services.

[Integration and verification details](docs/windows-code-signing.md).
