# Selecting CI work

PR and merge queue jobs use `scripts/ci/merge-plan.mjs`. A PR compares its head
with the merge base. The queue tests GitHub's combined head against the exact
queue base. Unreadable ranges fail the gate. Manual acceptance and release jobs
use their existing scopes.

## Merge gate

- App and server edits select portable tests through workspace imports, filenames
  and source-reading contract tests. An unmatched change or deleted input falls
  back to the owning package's portable suite. Shared types select their consumers. Broad server changes use Bun’s
  deterministic two-runner sharding. Each selected file runs once, including
  the isolated startup fixtures.
- Engine test discovery follows runtime imports and fixture helpers, including
  URL-loaded inputs. Type-only imports do not declare an engine requirement.
  Native relevance uses the reviewed component contracts in
  `scripts/ci/engine-test-contracts.mjs`, direct runtime subjects and explicit
  fixture inputs. Ordinary routes and shared type barrels use portable checks;
  their native API and schema contracts are listed explicitly. Loading an
  unrelated route through a complete server fixture does not select that
  fixture. Configuration/reload, credentials, models, permissions, native
  plugins and project/session recovery retain their own native acceptance tests.
- When adding a native fixture or changing the dependencies of its contract,
  update the owned inputs and fixtures in that file. A tooling test requires
  every discovered native fixture to belong to a declared contract. New
  unclassified production consumers of the native SDK fail open to the full
  engine gate. This is a maintained contract map, not proof that arbitrary
  runtime dependencies can be inferred from imports alone.
- Package licenses, publication file lists and unused new exports do not change
  existing engine contracts. Existing export-resolution changes select their
  consumers. Patches select their owning package's consumers, so desktop updater
  and renderer-editor patches retain their desktop/editor checks. Deleted
  inputs consult the base graph. Unknown inputs, server runtime dependency
  changes and server compiler settings retain broad native verification.
  The planning job installs the frozen server dependency closure without
  lifecycle scripts for analysis. Presentation-only changes keep the lightweight
  path. Focused checks use the reviewed Linux host engine and four workers.
  The repeated native file-permission flow runs first in its own process with
  one worker. Other native files retain their configured parallelism; all case
  assertions and deadlines stay unchanged.
  Provenance is verified on cache hits; a miss compiles the matching engine.
  Engine distribution, lifecycle and transport changes retain the full suite.
- Shared VM and isolation changes select the native matrix. Host-specific edits
  select that platform. Service and policy consumers run against the shipped engine and a real Linux
  x64 VM. Changes to boot, transport, filesystem or network enforcement also
  run the native sandbox battery.
- PDF rendering and password autofill run under Linux Electron with a virtual
  display. Browser panel capture, quit and window lifecycle fixtures use a native macOS session.
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
reads each PR head's source and manifests directly from Git, so later changes
to the checkout cannot invent historical import relationships. It reports any
engine selection separately from full engine and sandbox suite selections.
It does not measure hosted execution times. Computed runtime paths and external
services still require their existing broad input scopes; import analysis alone
does not establish equivalent regression detection.

`node scripts/ci/gate-timings.mjs RUN_ID ...` reads Actions job timestamps.
Supply the run IDs for the chosen cohort, including failures. Replay scores
use the first observation for each PR and keep all 50 in the denominator.
Different candidate revisions have separate scores. PR
and queue times include scheduling and wait for both required gates. A rerun that
recovers lists the original failing job and step for flake investigation. A warm
alpha needs an exact production-engine cache hit and all three signed outputs.
The report separates nonpublishing benchmarks. A failed or incomplete measured
run misses its threshold. A benchmark from before Mac artifact retention has no
combined availability timestamp. Scheduled-out candidates are outside the alpha cohort.

After rollout, measure every completed `dev` push since #370 landed:

```sh
node scripts/ci/gate-timings.mjs --alpha-since "$(gh pr view 370 --json mergedAt --jq .mergedAt)"
```

The `warm-alpha` summary includes candidates that attempted to download the
selected production cache. A failed download, a packaging
prerequisite failure or a missing publication counts as a miss. The target is
at least 90% of that cohort with all three signed builds published within 1,800
seconds of run creation. A total of zero means there is no measurement yet.

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

Alpha and release build the renderer and Office assets once for their native packagers.
The Windows installer uses compression level 5 and the Linux release tarball uses
gzip level 6. The original payload comparisons are recorded in the
[Windows run](https://github.com/eigenweltlabs/legalwork/actions/runs/42255869886)
and the [Linux run](https://github.com/eigenweltlabs/legalwork/actions/runs/41859349170).

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
node --test scripts/ci/{merge-gate,workflow-selection,change-scope,production-opencode-cache,engine-reuse-workflow}.test.mjs
node scripts/ci/replay-merge-plan.mjs
actionlint -shellcheck= -pyflakes=
```
