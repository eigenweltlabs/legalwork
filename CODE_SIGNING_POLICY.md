# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

Production certificate issuance is pending SignPath's integration review.
Test-signed builds are validation artifacts and are not published to users.

Authors and reviewers are repository maintainers
[Johann Machemer](https://github.com/johannmachemer) and
[Christian-Hauke Poensgen](https://github.com/christianhpoe). The release-signing
approver is Johann Frederik Machemer. Contributions from others require
maintainer review. Signing access follows SignPath's MFA requirements.

Signing requests originate from this repository's GitHub-hosted build jobs.
The production policy requires verified repository origin and one manual
approval. Artifact rules constrain the installer filename, LegalWork product
name, architecture, and build version. Bundled upstream binaries are not
re-signed under this project. The workflow verifies the returned signature,
timestamp, and updater metadata before publication.

See the [LegalWork privacy notice](https://eigenweltlabs.com/legalwork/privacy)
and [TERMS.md](TERMS.md) for local processing, model-provider and connector
transmissions, and optional analytics. Connected providers' privacy terms
apply to content sent to those services.

[Integration and verification details](docs/windows-code-signing.md).
