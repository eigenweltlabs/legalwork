# Reviewed OpenCode source preparation

The migration target is frozen at **OpenCode 2.1.4**, with LegalWork derivative
**`2.1.4-legalwork.http-policy.4`**. The recipe pins the upstream commit, original
frozen Bun dependency graph, official Bun 1.4.4 compiler per host and reviewed
MCP-readiness/Code Mode HTTP and migration timestamp patches. The SDK/client/plugin
ABI stays at 2.1.4.
OpenCode 2.2.0 is deferred by the user's decision. See the [current acceptance
status](../../../docs/opencode-v2-capability-status.md) for actual platform gates.

## Normal development and app builds

The build uses `bun.lock` and `package.json` from the exact upstream checkout;
LegalWork retains their SHA-256 pins in `recipe.json`, not duplicate file copies.
The commit and both files are verified before dependency installation, after
patching and before compilation. A moved tag, missing input or hash mismatch
fails the build. A cold build needs upstream availability; a verified current
artifact cache is reused offline without downloading source. Changed build
policy still invalidates older cached outputs.

Normal development and desktop/server/CLI build entry points call the shared
preparer before importing the fixed generated engine selection. Developers can
also run `pnpm engine:prepare`. Preparation builds the requested host target,
then verifies/reuses matching cached outputs on subsequent runs. A cold build
needs the pinned upstream source and dependency/compiler downloads; offline reuse
needs the complete verified cache. End-user startup does not compile source.
LegalWork uses pnpm; the user-approved isolated upstream build uses its original
frozen Bun installation without converting the upstream lockfile.

Committed `../selection.json` is the **source-build policy**. It does not select
the official binary or a public download URL. The ignored
`../generated/selection.json` and independent receipt are build-owned outputs,
validated against the source policy and recipe. Installed engines and archive
caches use the full manifest digest, keeping different same-version builds
separate. Every process reconstructs trust and verifies the actual five installed
files; environment/PATH overrides do not replace the compiled selection.

Production preparation (`pnpm engine:prepare:production`) requires the complete
twelve-target matrix and exact approved public Mac signer policy. Existing CI
imports the identity in an owned temporary keychain, signs Mac outputs **before**
provenance/checksums/archive pins, then removes that keychain. Production consumers
require the complete same-run distribution and its independent manifest digest.
Missing signing material never changes a production build into a development
build. The app signer preserves the pinned engine bytes. Development builds use
the explicit ad-hoc path and require no production identity.

The desktop and complete NPM platform bundles carry their verified engine files.
Node development remains supported. Bare standalone executable downloads,
GitHub/mirror fallback URLs and the separate raw-sidecar release route are
retired. The local sidecar manifest is retained for complete NPM bundle checks;
it does not authorize remote downloads. This preparation neither publishes an
engine release nor changes application auto-update delivery.

The source-build and actual app acceptance are separate gates. No complete
six-platform verdict is implied by cross-compilation, cache validation or these
documentation changes. The [combined patch receipt](../../../docs/patches/opencode-2.1.4-migration-times.receipt.json)
and the [historical evidence archive](../../../docs/opencode-v2-historical-evidence.md) preserve earlier exact evidence.

## Verification and low-level preparation

Run `node --test packages/opencode-release/*.test.mjs packages/opencode-release/build/*.test.mjs`
to check recipe input hashes, compiler identity, signing policy, artifact integrity and installation.
Native engine and actual app tests remain separate acceptance requirements.

For an explicitly prepared source tree, the low-level build entry is:

```sh
node packages/opencode-release/build/candidate.mjs \
  --prepared-source /path/to/tested-official-checkout \
  --bun /path/to/verified/bun \
  --target darwin-arm64 \
  --output /path/to/new-private-candidate
```

The output includes the binary, MIT license, derivative notice, provenance and checksums.
The build returns binary/provenance digests; production signing must precede those pins.
`distribution.mjs` verifies the supplied builds and assembles their per-target archives
and a new distribution manifest. This generated manifest is distinct from the archived
MCP-only candidate manifest, which is no longer exported or shipped.

```sh
node packages/opencode-release/build/distribution.mjs \
  --builds /path/to/reviewed-build-receipts.json \
  --output /path/to/new-local-archive-directory \
  --manifest /path/to/new-derivative-release.json
```

Candidate validation remains available through `verifyOpencodeCandidate` and the
explicit `build/validation-preload.mjs` test entry. Normal application startup uses
the prepared selection and does not read candidate-validation environment variables.
