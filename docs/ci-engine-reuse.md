# Engine reuse in CI

OpenCode is an input to LegalWork's integration tests. A change to an OAuth
connector or a desktop screen requires testing with the engine, but does not
change the engine source itself.

## Shared cache producer

`ci-opencode-cache.yml` runs on `dev` when the reviewed engine source policy,
patch, receipt, compiler recipe or build helpers change. Its first merge also
triggers a build because changes to the producer workflow are included. It
uses the existing development-only producer and saves its verified twelve-target
distribution in the `dev` cache scope, which PRs targeting `dev` can restore.

The cache key hashes engine inputs and build helper files, not LegalWork's commit ID.
The installed-file verifier and CI cache tool are excluded: changing diagnostics
or verification does not change compiled OpenCode bytes. Preparation retains its
separate fingerprint of the current verifier and always checks restored archives.
The existing current-policy, manifest, archive and provenance checks still run
before restored bytes are handed to test jobs. There are no partial restore
keys. A source/recipe change in a PR therefore builds that PR's engine rather
than reusing an older one. PR caches cannot overwrite the shared `dev` cache.

The warmer has its own concurrency group with cancellation disabled. Updating
or rebasing a PR does not cancel it. Multiple engine changes landing on `dev`
are serialized, allowing the active producer to finish saving its cache.

## Cache misses and recovery

Caches are temporary. If the shared cache is missing or evicted, the existing
PR producer builds and verifies a matching engine before tests run. This can
still be slow, and cancelling that PR before the save discards its unfinished
build. On a PR cache miss, CI can also reuse an existing engine artifact from the
PR's exact base commit and base branch, provided every fingerprinted engine input
and build helper matches. Other PR artifacts are excluded. This also seeds a new
cache-key version without recompiling unchanged OpenCode. The current verifier
checks all twelve archives and their provenance before saving or using them;
invalid artifacts fail the job. Production builds retain fresh compilation and
signing. Once the workflow is available on `dev`, maintainers can warm a missing
shared cache without publishing a release:

```sh
gh workflow run ci-opencode-cache.yml --ref dev
```

The warmer accepts only the `dev` ref. A PR that changes engine inputs uses its
own isolated cache until those changes are merged. No release, signing identity
or production build policy changes are part of this workflow.

## Unit checks and required integration gates

The Linux/macOS `unit-tests` matrix depends only on change selection. It runs
ordinary app/server tests and tooling checks without installing or
compiling OpenCode. Server/plugin builds and the pinned worker Node preparation
remain where unit fixtures require them. Tests that declare
`LEGALWORK_TEST_OPENCODE_BIN` skip their real-engine fixtures in this job.

The existing required `legalwork-tests (ubuntu-latest)` and
`legalwork-tests (macos-14)` names remain. They are final gates over every selected check, including units, integration,
protected-runtime tests and manual packaging acceptance. Integration starts as
soon as its verified engine is ready, independently of the unit matrix. A failed
selected producer or test is reported as a failed required check rather than a
skipped check. Pure presentation changes need only the successful unit matrix.

`scripts/ci/run-engine-tests.mjs` collects every server test file declaring the
real-engine fixture variable, including newly added files. It refuses to run
without the verified engine. Desktop runtime tests import the generated engine selection and therefore stay
in the engine integration job too. These tests, browser/e2e checks and prompt-cache
acceptance remain behind engine setup. The final selected-check summary also
includes the unit matrix. Sandbox skip labels and manual acceptance modes keep
their existing scope.

## Validation

```sh
PWSH_PATH=/path/to/pwsh node --test scripts/ci/*.test.mjs scripts/release/*.test.mjs
actionlint -shellcheck= .github/workflows/ci-tests.yml .github/workflows/ci-opencode-cache.yml .github/workflows/ci-opencode-derivative.yml
```

Workflow tests cover trigger/fingerprint inputs, independent unit selection,
required status failure propagation, real-engine test discovery, cache
verification and production-policy separation. A live shared-cache hit can be
checked after the producer is merged and completes on `dev`: the next ordinary
PR's engine job should restore and verify the cache while skipping compilation.


## Native archive delivery

The producer retains a complete twelve-target distribution and its pinned
manifest for universal publication and diagnostics. Native consumers download
only their macOS, Linux or Windows archive family, together with that complete
manifest. An explicit family selection is accepted only with an independently
pinned manifest digest; every delivered archive still passes its hash,
provenance and signature checks. The handoff receipt records its coverage, so
warming a family cannot masquerade as a complete distribution.

## Production engine reuse

Alpha and release producers look for an immutable production artifact named by
the current engine fingerprint. The identity covers the pinned upstream source,
patch/dependency/test-evidence recipe, compiler, build helpers, complete target
matrix, production certificate and entitlements. LegalWork's app version, UI
changes and unrelated server edits are not inputs. Changing engine inputs or
losing the retained artifact causes a fresh signed twelve-target build.

A production cache hit requires a completed same-repository production producer,
its successful full verification step, and the exact key plus unambiguous manifest
pin in its independently fetched GitHub job log. Normal publication accepts
trusted `dev` or release-event producers, not PR or arbitrary branch artifacts. An
explicit manual benchmark may reuse its own branch's prior manual producer.
Development caches and explicitly supplied development reuse inputs remain
separate and cannot satisfy production reuse.

Downloaded bytes must match that independent manifest and receipt. The existing
production verifier checks every archive and current source/provenance policy,
including actual native Apple signature and exact certificate checks for all
Mac targets. Corrupt selected artifacts fail the run. Cache hits do not import
private signing keys; misses retain the existing signing process and cleanup.
Only freshly built and verified full production distributions are retained in
the named cache for 90 days; normal same-run platform handoffs retain their
existing seven-day lifetime. This is retained-artifact reuse, separate from the
temporary development Actions cache.

To seed an engine without packaging or publishing:

```sh
gh workflow run alpha-macos-aarch64.yml --ref dev \
  -f signing_test=true -f warm_engine_cache=true
```

After that workflow completes, a fresh full nonpublishing alpha benchmark can
require a hit rather than silently recompiling:

```sh
gh workflow run alpha-macos-aarch64.yml --ref dev \
  -f signing_test=true -f require_engine_cache=true
```

The warm-up and full benchmark are separate runs. Report the full run's creation
time through each platform job's completion, including all producers, dispatch
and runner queues. Do not substitute native consumer duration or add overlapping
stage durations. Release creation, release asset upload and publication stay
disabled in these benchmark modes; signing and packaged startup still run.

[CI selection and rollout](ci-selection.md) covers merge checks, queue activation and production alpha timing.
