# Contributing to LegalWork

Submit focused pull requests against `dev`. Explain the change and include the
commands and results of relevant tests. See [AGENTS.md](AGENTS.md) for project
conventions and the pull request template for verification details.

## Contribution rights: Developer Certificate of Origin

LegalWork is [MIT-licensed](LICENSE). Contributions are submitted under that
licence; you retain your copyright. We use the
[Developer Certificate of Origin, version 1.1](https://developercertificate.org/)
(DCO) to record that you have the right to contribute the work. We do not require
a separate CLA granting broader commercial licensing rights.

Read the DCO before signing. Add your own sign-off to each commit:

```sh
git commit -s
```

This adds `Signed-off-by: Your Name <your-email@example.com>` using your Git
identity. The sign-off is a certification, not a cryptographic signature. Use
an email you are comfortable publishing, and obtain employer permission when
needed. Never sign for another person. Include source, licence and required
notices for third-party material, and do not submit confidential material.

The automatic **DCO** check reports commits missing a matching sign-off. If you
can make the certification for your most recent commit, amend it with:

```sh
git commit --amend --no-edit --signoff
```

For multiple commits, sign each of your own commits using an interactive rebase;
do not rewrite other contributors' commits without coordinating with them.
After rewriting a branch already on GitHub, update your PR branch with
`git push --force-with-lease`. GitHub's web editor also supports a sign-off when
that repository setting is enabled; otherwise use Git locally.

## Maintainer rollout

After merging the workflow, test unsigned and signed commits from a fork and
require the **DCO** check in branch rules for `dev`, preserving the existing `prod` ruleset and its other protections.
The workflow executes only trusted action code and reads PR commit metadata;
it has no write permissions and no contributor exemptions. These sign-offs
apply prospectively, not as proof of rights in existing contributions.
