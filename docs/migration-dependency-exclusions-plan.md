# Migration dependency exclusions

Skip installed Node dependencies, recognized Python virtual environments and the agreed Python/package/build/browser caches inside the two migrated support trees. Identify Python environments by their existing `pyvenv.cfg`; inspect only directory metadata. Preserve `.env` files, manifests/lockfiles, scripts, documents, attachments, downloads, generic scratch/build/dist/vendor folders, browser state and Git history. Do not generate package lists, environment exports, installation instructions or regeneration jobs. Do not modify the production profile during development.

Use one exclusion policy for hashing, copying, link traversal, backups and measured progress, pruning before visiting excluded contents. Record only the exclusion-policy version in the existing ownership receipt. Old unpublished copies may adopt the policy only when their retained data and normalized links match the original; preserve divergent copies. Previously published legacy originals remain preserved rather than rehashing excluded data to retire them. Existing copied dependencies are not purged.

Suppress whole-tree cloud pinning for managed legacy roots during startup and workspace initialization; retained migration reads hydrate only the needed files. Keep normal pinning for unmanaged and already-local projects. Implement first, then add focused data-preservation/exclusion/resume regressions and run the existing storage/native migration checks, server types/build and generated-help checks.

## Implemented policy

- Omit `node_modules`, `.pnpm-store`, recognized Python environment directories (existing regular `pyvenv.cfg`), and conventional `venv`/`.venv` links without following targets.
- Omit `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.npm/_cacache`, `.yarn/cache`, pip's `http`/`http-v2`/`wheels`/`selfcheck` caches under `pip-cache` or `.cache/pip`, `.cache/uv`, `.next/cache`, `.turbo`, `.parcel-cache` and `.vite`.
- Omit known Chromium caches only at generated `chrome-profile`/`browser-profile` roots or their standard profile directories. Preserve cookies, preferences and similarly named document folders elsewhere, including browser downloads.
- Apply the same policy to initial inspection, copying, verification, link relocation, backups and progress. Retained data still receives the existing content and ownership checks. No package inventory, environment export or regeneration is introduced.
- Resume older unpublished copies by comparing retained source/copy bytes, modes and equivalent relocated links before saving the policy version. Preserve conflicting copies and already-copied dependencies. Previously published migrations retain their original recovery trees because a filtered baseline cannot safely be inferred from an old full-tree hash after local work begins.

## Validation — 2026-11-09

Validated on macOS arm64 with Bun 1.4.4 and the existing verified development engine; no Alpha download or production-profile migration was performed.

- `pnpm --filter legalwork-server build`: passed.
- `pnpm --filter legalwork-server typecheck`: passed.
- `pnpm docs:generate` and `pnpm docs:check`: passed.
- `LEGALWORK_TEST_OPENCODE_BIN=<prepared-engine> bun test --preload ./apps/server/test-preload.ts ./apps/server/src/project-storage.test.ts ./apps/server/src/workspace-init.test.ts ./apps/server/src/project-storage.released.test.ts`: **32 passed**, 355 assertions. Covers omitted dependency/cache contents with FIFO payloads that cannot be traversed, preserved work/configuration/browser data, exact copy counts, backups, interrupted-copy compatibility/conflicts, native V1 history migration before relocation, offline reopen, and suppression of legacy cloud pinning.
- `bun test --preload ./apps/server/test-preload.ts ./apps/server/src`: **3,402 passed, 189 skipped, 9 failed**. Two failures were a missing generated local Node fixture; after supplying the existing cached runtime, all 14 native-config-state cases passed. The remaining seven failures also reproduce on unchanged base content (tree identical to `2c13bc54b`): Assistant HTTP provisioning, Assistant scheduled research, sandbox settings HTTP, scheduled-task HTTP, calendar HTTP, email-draft HTTP and raw HTTP sandbox routes. Those failures are outside this change; the full suite is not green.

The production profile was inspected only through metadata in the investigation. Development and validation used isolated synthetic projects and databases.
