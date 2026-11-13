# Assistant launcher integration with dev — 13 November 2026

Integrated upstream `dev` at `a51fe046291d9f9380af385d5128a2ad593bb8e9`
onto the existing launcher branch, preserving its history and Assistant base.
This brings in 21 upstream commits since the previous integration: local project
and wiki engine homes, file migration and path handling, Back Office, bounded
chat history, Assistant recovery, DOCX saves, OCR and desktop/runtime fixes.

## Compatibility changes

- Search, recents validation and folder browsing use the project's document
  root (`contentPath`), matching the main application. Old indexes are replaced
  when that root changes; unavailable roots report unavailable coverage.
- Document creation, templates and cross-project transfers use document roots.
  Retry receipts and audit data stay in the internal project home. Writes
  invalidate the filename index, and existing collision and symlink protections
  remain in force. Word documents are saved compressed.
- Native drag-out and file clipboard actions use the same document root.
  Standalone Raycast Open/Show in Finder/Copy File also use it. Draft with
  Assistant names the actual destination instead of an ambiguous path relative
  to the engine home. Existing main-app document opening consumes upstream's
  updated project-file resolver.
- Attachment staging remains internal, with upstream's relocation handling for
  restored attachment references. Chat identities and unsent drafts are retained.
- Preserve deferred background startup, migration guards and explicit Assistant
  initialization. Background shell observation no longer creates an engine.
  Daily cloud history participates in backward/forward history navigation and
  remains isolated by account when browsing frozen pages.
- Keep both Back Office and launcher/cloud integrations when resolving conflicts.
  Correct one newly inherited German imperative caught by the language check.

## Validation

Passed against the combined tree:

- App launcher, links, clipboard, Assistant navigation/history and document
  runtime: **161 tests** (159 in the main batch, plus two new history regressions).
- Server launcher, submissions, queues, tasks, channel history and project
  storage: **163 tests**, including migrated project/wiki roots, document retry,
  preview, transfer, visibility and deleted-file handling.
- Desktop launcher: **47 tests**; standalone Raycast file helpers: **2 tests**.
- Native Assistant execution and project/session migration using the freshly
  prepared pinned engine: **6 tests**. Synthetic fixtures; no paid model calls.
- App and Electron typechecks, server build, UI production build, Raycast
  typecheck/build, IPC coverage (143 methods), dependency parity, translations
  (8,183 keys in English/German) and generated help checks.

Representative commands:

```sh
pnpm install --frozen-lockfile
pnpm engine:prepare
pnpm --filter @legalwork/app typecheck
pnpm --dir apps/server build
NODE_OPTIONS=--max-old-space-size=8192 pnpm build:ui
node --test apps/desktop/electron/launcher/*.test.mjs
pnpm --filter @legalwork/desktop check:electron
pnpm --dir apps/server exec tsc -p ../desktop/tsconfig.electron.json --noEmit
pnpm --dir apps/raycast-legalwork typecheck
pnpm --dir apps/raycast-legalwork build
pnpm --filter @legalwork/app test:i18n
pnpm docs:generate
pnpm docs:check
node apps/desktop/scripts/check-server-deps.mjs
```

Bun suites use `pnpm dlx bun@1.4.4 test` from the relevant app/server/extension
directory. Native fixtures additionally set `LEGALWORK_TEST_OPENCODE_BIN` to
the freshly prepared derivative. The first UI build exhausted Node's default
heap; it passed with the heap setting above. Existing large-bundle warnings and
native fixture shutdown connection-reset logs remain; assertions passed.

No computer-use tests or real Finder gestures were performed. Manual acceptance:
invoke the mini-bar, search a file in an upgraded project/wiki, open it in the
app, create a document in a subfolder, copy/drag a result to Finder, and resume
an existing chat with an attachment. External-provider federation and the
previously deferred Preview/Copy Path remain outside this integration.

The Assistant PR base has not moved. This integration does not rewrite inherited
authors or sign-offs, and does not resolve the existing DCO comparison problem.
