# Selecting CI work

Automatic checks use `scripts/ci/change-scope.mjs` through the `ci-scope` action.
It inspects the complete PR diff from its merge base, or every commit in a push.
Deleted and renamed files count. Missing history, unknown inputs and shared
dependency changes select all checks instead of silently dropping coverage.

## Automatic workflows

| Workflow | When its work runs |
| --- | --- |
| LegalWork Tests | Affected app, server, desktop and tooling suites; native engine tests for engine consumers; VM tests for permission, sandbox and runtime changes. Pure UI primitives, styles and translations do not require an engine. |
| i18n Audit | App source, translation tooling and shared inputs. |
| DOCX interoperability | Document artifacts, DOCX tests/fixtures, dependency changes and its workflow. |
| legalwork-ui-mcp | That package, shared dependencies or its workflow. Publishing still requires its package tag. |
| DCO | Every PR update: sign-offs depend on commits, not file paths. |
| Alpha Channel (Mac and Windows) | Dev pushes affecting the shipped app or its build inputs; explicit manual runs remain available. README/architecture notes alone do not build alpha binaries. Bundled user-guide changes do affect the app. |
| Refresh alpha update feeds | Relevant release events, explicit requests, or an alpha run that actually completed a publication job. Skipped alpha builds do not refresh feeds. |
| Download Stats | Its existing six-hour schedule or an explicit request. This collects analytics rather than testing code. |

PR workflows report skipped **jobs** rather than disappearing through workflow
path filters, so required checks can resolve. `Selected checks passed` reports
failures and cancellations in any selected job, including failed prerequisites.
Repository protection can require that aggregate check. This change does not
edit repository protection settings.

## Engine reuse

The development producer caches the complete engine distribution under an exact
key covering the pinned source, patches, compiler, targets, build helpers and
CI producer/verifier. A hit still passes the existing archive/provenance checks
before another job can install the engine. A corrupt cache fails the run; it is
not accepted or silently overwritten. A miss compiles the pinned source.

Cache storage contains development binaries and build metadata, never signing
keys or other credentials. GitHub's branch/PR cache isolation applies. A new PR,
an expired cache or changed build inputs can require another build. Explicit
reuse of a named Actions producer and an independent manifest digest remains
available. Production-signing builds never use the development cache.

## Explicit acceptance and release workflows

The engine producer, six-host source-build verification, desktop packaging,
Windows archive acceptance and Mac signing verification are reusable workflows;
they do not independently start on pushes. The existing manual modes select
them. Storage OAuth review builds retain their manual platform selection.

Full desktop acceptance still exercises all six shipped OS/CPU combinations.
Storage migration and remembered-permission tests now run inside those package
jobs rather than in six duplicate jobs. Native cold-source-build acceptance
deliberately bypasses build reuse, because a fresh build is what it tests.

Stable releases remain explicit tag/manual operations with the existing signing,
packaging and verification. A release without desktop packages skips preparing
the desktop sandbox. No release is triggered by this CI change.

Repeated manual requests for the same branch and acceptance mode supersede the
older run; different modes remain independent. Publishing workflows keep their
existing concurrency rules to avoid interrupting publication midway.

## Limits of change filtering

Filtering is deliberately conservative at shared boundaries. In particular, a
large migration PR still touches many areas and therefore selects many checks
on later updates, even if its most recent commit is small. Looking only at that
last commit would not validate the complete PR. Engine reuse avoids recompiling
unchanged engine inputs while those tests still run against the current app.

Validate changes with:

```sh
node --test scripts/ci/*.test.mjs scripts/release/*.test.mjs packages/opencode-release/*.test.mjs packages/opencode-release/build/*.test.mjs
actionlint -shellcheck= -pyflakes=
```
