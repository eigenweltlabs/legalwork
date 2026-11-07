# Local project support storage implementation

User authorized implementation on 2026-11-07. Worktree: `legalwork-project-storage-proposal`; branch: `codex/local-project-storage`. Tests are deferred until the implementation and path audit are complete.

## Contract

- Move only `.opencode` and `.legalwork`, preserving their complete internal layouts, into a stable local home per existing project ID.
- `workspace.path` becomes the local engine/project home. A persisted `contentPath` identifies ordinary documents. One shared resolver returns the content path; absent means a legacy/unmigrated workspace.
- Keep existing IDs, shared database locations, ordinary documents, outside downloads, credentials and existing authorized folders. No move-files feature.
- New projects without an external folder use `<local-home>/files` for documents. Native locations and chat identity use the local home. The file UI and document IO use contentPath.
- Reuse existing additional-folder permissions and protected file broker. Local home is `/workspace`; connected content is an authorized folder. Both sandbox modes remain supported.

## Implementation sequence

1. Add shared path/root contracts and platform-local project directory resolution. Persist and serialize the new root roles through server, desktop and UI metadata.
2. Add journaled, per-project startup/creation migration. Copy/verify support trees without merging conflicts or deleting original bytes before verification. Missing sources remain pending. Reconcile engine session locations and preserved history state through a supported migration boundary; do not silently strand older chats.
3. Route hidden-folder stores/configuration to local path, and ordinary files, sync, document preparation inputs, linked source documents, editor/Office matching and file reveal/copy to the content resolver. Mixed consumers receive both roots explicitly.
4. Bind permissions, sandbox mounts, agent tools and context reminders to the local engine root plus primary content path. Preserve project and chat restrictions and avoid new broad parent-directory grants.
5. Reconcile desktop registries and startup/recovery, creation, import/export, reset/cleanup, offline content behavior and UI path displays. Update user help and generated skill instructions.
6. Audit every tracked path occurrence and indirect consumer against the source inventory. Record any deliberately unchanged global/legacy references and remaining limitations here.
7. At the end, add focused migration/path regression coverage, run relevant existing server/desktop/UI tests, type checks, help generation/checks and a realistic engine/file-flow check where the environment supports it. Fix failures, then report exact results and remaining platform limits.

## Acceptance

Existing project documents remain in their original folder. Both hidden trees are local and retain their suffixes. Existing chats, attachments, reviews and sync identity remain accessible. New projects use local storage. Agent file operations can address content and retained local attachments, with sandbox on and off. A disconnected content folder does not prevent local engine startup or access to retained local data.

## Progress

- Plan recorded before implementation.
- Implemented dual-root serialization, platform-local homes, verified support migration, native session relocation, recoverable retirement and local backups. Retired snapshots remain at the source under `.legalwork-migrated` names for other installations upgrading a shared folder; runtimes never use those archives.
- Adapted document IO, UI preview/reveal/Office matching, creation (UI/assistant/sync), sync staging/trash, review/corpus/preparation inputs, working copies, delegated files, sandbox mounts, path permissions and dynamic agent reminders.
- Intentionally retained local-root references for engine/session identity, settings/skills/plugins, hidden stores, audit, reviews, drafts, attachments and connector downloads. Shared runtime/history databases keep their existing locations. Wiki workspaces retain their independent storage model. Standalone externally managed engines keep legacy registration behavior; automatic migration belongs to managed startup.
- Verification phase follows the implementation and help updates; no tests were run during the path-editing phase.


## Verification

Checks were run after the implementation and path audit, as requested. Test failures were corrected before completion.

- `pnpm --filter legalwork-server build`: passed; includes TypeScript, generated resources and native plugin bundles. Shared path helpers have a plain JavaScript server bundle for packaged Node/Electron use.
- `pnpm typecheck` and `pnpm build:ui`: passed.
- `pnpm docs:generate` and `pnpm docs:check`: passed.
- Focused server regression run: **204 passed, 9 skipped, 0 failed** across 15 files. Covers file APIs, reviews/preparation/corpus, sync, working copies, sandbox policy, history permissions and managed lifecycle. Skips require external reference storage services.
- Additional final regression run: **36 passed** across 7 files, including migration, plugin reminders and project registration. Final mount checks also cover default projects without duplicate mounts of their `files` directory (**63 passed** in the combined migration/mount run).
- UI file/editor/Office/attachment/registry tests: **61 passed** across 7 files.
- Desktop runtime, registry/recovery, profile-reset preservation and file-copy tests: **53 passed**. Platform path assertions cover macOS and Windows.
- Pinned native engine checks: **2 passed**. Verified parent and child chats, original IDs and timestamps, permission rebasing, queued attachment URI compatibility, real managed startup/cutover, service promotion, and restart with the content drive unavailable while the old chat and local attachment remain readable.
- `git diff --check` and Electron main-process syntax check: passed.

The installed Bun 1.3.14 cannot load the locked Undici dependency. Server/UI tests use the engine build's pinned Bun **1.4.4** at `.legalwork/opencode-build/*/compiler/package/bin/bun`; native checks set `LEGALWORK_TEST_OPENCODE_BIN` to that build's `build-darwin-arm64/artifact/opencode`. Build outputs are ignored, not part of the source change.

Runtime verification was on macOS ARM64. A Windows runtime and an actual SMB/FUSE VM were unavailable; Windows path handling and sandbox mount/policy behavior were verified through the existing regression surfaces. The existing filesystem broker was reused.

## Completed path audit

Engine/session identity, native projection ownership, history provenance/undo and approval migration use the local home and its retained old-directory alias. Document IO, editor/reveal/download destinations, Office matching, source discovery and document sync use the content root. Mixed operations receive both roots explicitly. Attachments, drafts, review/preparation outputs, connector downloads, audit and sync staging/trash remain at their existing suffixes under the local home. Native file tools retain standard OpenCode path resolution. Application file links and queued support-file URIs retain compatibility with migrated hidden-folder files without rewriting immutable transcripts. Sandbox reminders distinguish host engine paths, host document paths and guest command paths. Default local documents are reachable as `/workspace/files`; a separate connected folder uses `/authorized/0` alongside existing additional folders.

Only the managed desktop/CLI startup owns automatic engine/history migration. A separately operated external engine keeps its existing registration behavior. Retired source snapshots are recovery data for other computers; a changed original is preserved. Completed migrations do not probe the connected drive at startup. Profile resets preserve project homes and connected files, including the macOS `Projects` directory now nested under Application Support. Wiki workspaces and shared runtime/history database locations are intentionally unchanged. Root-level authored files outside the two requested hidden trees are not moved.

## Ordering correction — OpenCode upgrade first

Requested after review: complete the existing OpenCode history upgrade before copying either hidden folder or changing registered project paths.

Implementation steps (recorded before this correction):

1. Keep predecessor shutdown and legacy settings/history backup preparation early, but remove the early project-folder migration from embedded and CLI startup.
2. When legacy project folders are pending, force the existing plain-serve recovery bootstrap. Its factory already waits for OpenCode's native migration-completed status. Keep new agent admission and project mutations closed during this phase.
3. After that bootstrap succeeds, close its engine, copy/verify the two folders, persist the new roots, republish generated configuration and restart the recovery engine. Reassociate existing chats only against the upgraded history; service recovery follows those checks.
4. Start background sync, scheduled work and root-bound file watchers after startup migration finishes, so they cannot write old folders during the copy.
5. At the end, verify success ordering, failure preservation (no folder/path cutover if OpenCode migration fails), existing lifecycle behavior, and the pinned-engine upgrade followed by offline restart. Preserve the existing worktree and all prior changes.

Correction implemented and verified:

- Managed embedded and CLI startup now finish the native history upgrade before stopping the bootstrap engine and invoking the folder copy. Root-bound watchers, sync, Assistant background work and schedules start after this transition. Project creation and new engine admissions are held during the upgrade.
- Pinned native engine storage checks: **3 passed**. Covers existing parent/child chats, a real V1 history conversion followed by local-folder cutover and offline restart, and an actual native conversion failure that leaves source folders and registered paths in place.
- Lifecycle, storage, registration, sync and scheduled-work regressions: **72 passed, 1 skipped** across 8 files. Additional released-engine lifecycle/scheduled-work checks: **2 passed**.
- Assistant, queue, schedule and watcher checks: **33 passed, 1 skipped** across 7 files, including the separately rerun HTTP flow after fixing its remaining single-root document-sharing assumption. Assistant summaries expose the content root; file sharing resolves ordinary documents and local support attachments through the shared root resolver.
- Server build, bundled-help check and `git diff --check`: passed. Checks used the same pinned Bun and native engine described above.

Draft PR preparation: rebased onto `dev` at `62eb0f717`; the only conflict was the generated help bundle, regenerated from the combined source. Rechecked the server build, UI typecheck, help consistency and diff whitespace. Post-rebase regressions passed: **52 server tests** across storage, registration, lifecycle and engine configuration; **63 UI tests** across registry, Office matching, document runtime and attachments; **5 real-engine tests** covering storage migration, legacy connector migration and scheduled work.

## Native file paths — standard OpenCode behavior

User requested removing the custom native file-tool router. Before editing: remove the argument-rewriting hook (including search defaults, patch headers and multi-edit paths), retain existing folder permissions and application file-link compatibility, and update runtime context and documentation. Native relative paths will resolve from the local engine/project home. Connected documents will use explicit host paths; shell commands can select the connected folder as their working directory. No symlinks are introduced. At the end, adapt the existing released-engine folder-permission check to verify local relative files and explicit connected documents, run the relevant build/regressions and update draft PR #405.

Implemented: the managed-config file-tool router and its private settings metadata are removed. The agent's runtime reminder now describes native project-relative resolution and explicit connected-document paths. Verification after removal: **38 passed** across storage, managed configuration and sandbox plugin checks; **5 real-engine tests passed** across project folder permissions and storage migration. The existing permission test now uses a distinct connected content root and identically named files to verify that native relative reads select the local project file while explicit connected reads select the document. Server build, help generation/check and diff whitespace checks passed.
