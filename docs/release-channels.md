# Desktop update channels

![Release, Pre-release, and Alpha in the app selector](images/release-channels-selector.png)

| App selection | Eligible published releases |
| --- | --- |
| Release (default, stored as `stable`) | Regular versioned releases |
| Pre-release | Regular releases and versioned releases manually marked Pre-release |
| Alpha | Regular releases, pre-releases, and automatic alpha builds |

The app chooses the highest semantic version with an uploaded updater manifest
and installer for its OS and CPU. Drafts and internal rolling pointer releases
are excluded. Alpha tags never enter Pre-release, even though GitHub also marks
them as prereleases. GitHub's Latest badge, API order, and publication date do
not decide version precedence. A selected feed is pinned to that release for
both the update check and download. Channel changes never permit downgrades.

After selecting the release from GitHub metadata, the app checks
`https://eigenweltlabs.com/legalwork/update/releases/<tag>/<manifest>`.
The website redirects to that exact GitHub release; it never substitutes
Latest. If the website fails or returns a manifest for another version, the
app retries the same selected release directly on GitHub. The answering feed
remains applied for downloads. Deploy the website route before releasing this
client; older websites safely trigger the direct GitHub fallback.

For gradual updates, electron-updater creates a random installation ID on the
first update check, stores it locally as `.updaterId`, and reuses it to keep an
installation in a consistent rollout group. Update-check requests include this
ID as `x-user-staging-id`, along with the current app version and selected
channel. The updater uses the manifest's staging percentage to decide whether
an installation is eligible for that release.

Automatic checks run at startup and at most hourly while the main app is visible,
including a due check after focus/resume. They honor automatic-update settings
and firm policy, and leave downloading or ready-to-install updates alone.

For example, Pre-release users receive v4.0.0 when v3.0.0 remains marked
Pre-release and v4.0.0 is a regular release. Publishing v5.0.0 as Pre-release
offers it to Pre-release and Alpha users. Removing the flag later offers the
same artifacts to Release users without rebuilding.

## Publication

- Every push resulting from a merge into protected `dev` starts the existing
  macOS arm64 and Windows x64/ARM64 alpha workflows. Required PR checks run
  before merge; the LegalWork Tests workflow is not repeated on the merge push.
- Alpha packaging builds the shipped sandbox runtime with `run_tests: false`.
  Signing/notarization and packaged startup verification remain in place. Full
  sandbox validation is available only as a manual alpha-workflow opt-in.
- Each commit keeps its own alpha run. A new merge does not cancel the previous
  commit's build. Artifacts upload into a draft alpha before it is published;
  reruns preserve already published immutable alpha assets.
- The existing Release App workflow remains unchanged. Version tags build a
  draft. Maintainers choose the Pre-release flag and publish the draft manually.
  No dev-merge job publishes or changes the labels of versioned regular releases.

The app reads published GitHub release metadata, with a shared 60-second cache,
so manual flag changes need no deployment. API outages use the existing regular
and alpha feeds; upgrade-only checks still apply. A healthy metadata response
with no eligible release does not fall back to a potentially withdrawn version.

## Rolling alpha compatibility feeds

`Refresh alpha update feeds` is the sole writer of `alpha-macos-latest` and
`alpha-windows-latest`. It runs after successful alpha workflows and manual
release publication/label edits. Each serialized run recomputes the newest
eligible release, rather than copying whichever build just finished. It never
replaces a pointer with a lower version. Manifests contain immutable installer
URLs and retain the original SHA-512 hashes. The refresh workflow only uploads
manifests to these existing pointers; it cannot publish a regular release.

Pre-release works on macOS, Windows, and Linux. Automatic alphas retain the
existing macOS arm64 and Windows x64/ARM64 build coverage. Other architectures
receive the newest eligible regular release or pre-release.

## Focused validation

```sh
node --test apps/desktop/electron/release-feeds.test.mjs apps/desktop/electron/updater.test.mjs scripts/release/release-channels.test.mjs
bun test apps/app/tests/release-channels.test.ts apps/app/tests/update-preferences.test.ts
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/desktop typecheck:electron
```

These cover stale labels, numeric version ordering, promotion without rebuild,
draft/alpha exclusion, all six platform/architecture combinations, incomplete
uploads, pagination, metadata failures, pinned manifests, channel switching,
and the manual-publication workflow contract. They do not launch sandbox VMs.
