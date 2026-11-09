# Selecting CI work

PR and merge queue jobs use `scripts/ci/merge-plan.mjs`. A PR compares its head
with the merge base. The queue tests GitHub's combined head against the exact
queue base. Unreadable ranges fail the gate. Manual acceptance and release jobs
use their existing scopes.

## Merge gate

- App and server edits select portable tests through workspace imports, filenames
  and source-reading contract tests. An unmatched change or deleted input falls
  back to the owning package's portable suite. Shared types select their consumers.
- A changed real-engine fixture or its matching implementation selects focused
  tests on Linux. The runner prepares the reviewed host engine, verifies its
  provenance on cache hits and compiles that host on a miss. Dev warms the
  Linux host cache when its inputs change so PRs can restore it from their base.
  Desktop unit tests use the same verified selector. The full engine suite
  runs for changes to distribution, engine lifecycle, transport or pinned SDK inputs.
- Shared VM and isolation changes select the native matrix. Host-specific edits
  select that platform. Ordinary sandbox service changes use Linux x64.
- Every candidate checks that desktop declares the server's shipped runtime
  dependencies. CI also verifies bundled plugins after building the server.
  Signed installers run on alpha and release. An explicit package acceptance
  dispatch remains available.

## Enabling the dev queue

Land the merge-group handler on `dev` before enabling GitHub's queue. Preview
the exact change to the current repository ruleset with a read-only command:

```sh
gh api repos/eigenweltlabs/legalwork/rulesets/18320382 | node scripts/ci/dev-queue-ruleset.mjs
```

After the handler has landed, a repository administrator can activate the
previewed configuration from the merged checkout:

```sh
node scripts/ci/dev-queue-ruleset.mjs --enable
```

The command checks the live dev handler, retains both required checks, disables
strict head freshness and verifies the updated ruleset. After activation, choose **Merge when
ready** for a PR. GitHub creates and tests a temporary commit including earlier
queue entries. A failed group cannot merge. A true source conflict still needs
a resolution.

## Measuring the rollout

`node scripts/ci/replay-merge-plan.mjs` replays the 50 pinned GitHub base/head
pairs from all authors. Run in a checkout with both revisions available. For a
missing PR head, fetch `refs/pull/NUMBER/head` or the pinned commit. The replay
counts full-suite selections. It does not measure hosted execution times.

`node scripts/ci/gate-timings.mjs RUN_ID ...` reads Actions job timestamps.
Supply the run IDs for the chosen cohort, including failures. PR
and queue times include scheduling and wait for both required gates. A rerun that
recovers lists the original failing job and step for flake investigation. A warm
alpha needs an exact production-engine cache hit and all three signed outputs.
The report separates nonpublishing benchmarks. A failed or incomplete measured
run misses its threshold. A benchmark from before Mac artifact retention has no
combined availability timestamp. Scheduled-out candidates are outside the alpha cohort.

To measure actual hosted time before rollout, manually dispatch **LegalWork Tests**
on the candidate branch with only `replay_pr` set to a number in the cohort.
This runs the regular gate using that PR’s historical diff against the current
checkout. Each replay has its own concurrency group and cannot publish. Use
these timings for a routing benchmark, then measure real PR readiness after rollout.

## Automatic workflows

| Workflow | When its work runs |
| --- | --- |
| LegalWork Tests | Affected app, server, desktop and tooling suites; native engine tests for engine consumers; VM tests for permission, sandbox and runtime changes. Pure UI primitives, styles and translations do not require an engine. |
| i18n Audit | Runs inside the required PR and queue check for app source, translation tooling and shared inputs. The standalone push check remains available. |
| DOCX interoperability | Document artifacts, DOCX tests/fixtures, dependency changes and its workflow. |
| legalwork-ui-mcp | That package, shared dependencies or its workflow. Publishing still requires its package tag. |
| DCO | Every PR update: sign-offs depend on commits, not file paths. |
| Alpha Channel (Mac and Windows) | Dev pushes affecting the shipped app or its build inputs; explicit manual runs remain available. README/architecture notes alone do not build alpha binaries. Bundled user-guide changes do affect the app. |
| Refresh alpha update feeds | Relevant release events, explicit requests, or an alpha run that actually completed a publication job. Skipped alpha builds do not refresh feeds. |
| Download Stats | Its existing six-hour schedule or an explicit request. This collects analytics rather than testing code. |

The required workflow reports skipped jobs so both required checks resolve. `Selected checks passed` reports
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

Validate changes to merge routing with

```sh
node --test scripts/ci/{merge-gate,workflow-selection,change-scope,deploy-benchmark-workflow,engine-reuse-workflow}.test.mjs
node scripts/ci/replay-merge-plan.mjs
actionlint -shellcheck= -pyflakes=
```
