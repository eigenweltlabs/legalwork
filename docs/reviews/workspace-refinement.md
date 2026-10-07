# Workspace navigation and window coordination

Project Overview, Calendar, Tasks and Tabular Review lists are now singleton tabs in the retained project workspace. Clicking a project name returns to that workspace; its chevron only expands the sidebar. Global pages keep their own area and expose a return action. The whole-workspace maximize button is removed; individual documents still maximize.

The pane's `+` menu opens these project views, a chat, files or a browser. Opening a project task keeps its detail in the initiating pane. Creating or editing a global task/workflow stays in the global area. Asynchronous tab requests retain their originating project and pane. Sidebar chats can be dragged into tab groups or any split edge, with the existing six-pane limit.

## Windows and editing

The header opens a second workspace window, including when a document is focused. A tab's context menu opens only that content. The new window receives navigation and pane geometry, with fresh native browser instances; composer buffers and editor histories are not copied. Connected-storage tabs retain their source identity and permissions rather than reopening the temporary checkout as a normal editable file.

`Edit here` freezes the current document owner while it checks pending writes. If the document is dirty, the requesting window offers:

- Save those changes to the original, then edit here.
- Keep the unsaved draft as an ordinary sibling file, then open the saved original.
- Cancel and return editing to the original window.

The owner checks the draft revision before applying the choice. A failed save or copy prevents release. A timed-out or closed requester cannot silently discard the draft. The general recovery/version UI remains unchanged; its redesign is deferred.

![Explicit choice before taking over an unsaved document](workspace-refinement/handoff-choice.jpg)

The screenshot contains only synthetic preview content.

## Shared message queue

Queued messages belong to the server and are polled by each window. Unsent composer buffers remain window-local. Pause, order, attachments and queued edits persist across renderer/server restarts. Editing a queued message takes a renewable lease and pauses delivery; another window cannot remove or overwrite that reserved item.

One server dispatcher sends messages in order. Submission IDs make acknowledgement retries idempotent. An interrupted or uncertain send pauses delivery for review instead of silently retrying. Queue files are written atomically with private filesystem permissions. This assumes the app's existing single-backend runtime; it does not coordinate independently launched servers writing the same queue directory. Updated client and server must ship together.

## Validation

| Command | Result |
| --- | --- |
| `pnpm --filter @legalwork/app test` | 933 passed, 0 failed |
| `pnpm --filter legalwork-server exec bun test src/session-message-queue.test.ts src/session-read-model.e2e.test.ts src/artifact-files.e2e.test.ts` | 27 passed, 0 failed |
| `pnpm --filter @legalwork/desktop test` | 195 passed, 1 skipped, 0 failed |
| `pnpm --filter @legalwork/app typecheck` | Passed |
| `pnpm --filter legalwork-server typecheck` | Passed |
| `pnpm --filter @legalwork/desktop typecheck:electron` | Passed |
| `pnpm --filter @legalwork/desktop check:electron` | Passed, 110 bridge methods |
| `pnpm --filter @legalwork/app test:i18n` | 5,506 keys complete in English and German |
| `node scripts/i18n-audit.mjs --ci` | Passed |
| `pnpm build:ui` | Passed, existing bundle-size warnings |

Interactive checks used `/session-preview.html?unified=1` with synthetic documents and no connected services:

1. Open project Overview and Tasks. Create a task and verify its detail opens in the same pane.
2. Visit global Home, return to the project, and verify the retained layout. Create a workflow from the global library and verify the editor stays there.
3. Drag a sidebar chat to a split edge and verify the existing pane stays in place.
4. In two browser windows, open the same Markdown file. Check Cancel, Save, and Keep a copy during dirty handoff; verify the first window pauses while the choice is open and only one editor remains writable.
5. Repeat Keep a copy with the pinned DOCX editor and `apps/app/scripts/fixtures/legal-review.docx`: the receiving window opens the unchanged original, without the unsaved test prefix. Check individual document maximize/restore.
6. In an isolated Electron profile, open a task and DOCX in separate panes. Use the header's new-window button and verify both panes and active tabs transfer. Use the DOCX tab's context menu and verify the next window contains only that document, initially read-only.

Queue integration tests use a real local HTTP server and a mock agent transport, covering shared reads, authentication, read-only servers, stale edits, archive restoration before dispatch, deletion, attachment persistence, lost acknowledgements and interrupted sends. No live model run or connected-storage publishing was performed for this change.
