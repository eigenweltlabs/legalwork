# Workspace navigation and window coordination

Project Overview, Calendar, Tasks and Tabular Review lists are separate project destinations by default. A permanent **Workspace** sidebar entry returns to the retained chats, files and layout. Visiting an overview preserves mounted editors, drafts, undo history and scroll state. An overview can be deliberately opened as a singleton work tab through **Open … as a tab**. Individual documents still maximize; the redundant whole-workspace maximize button is removed.

Workspace has a separated, subtly shaded sidebar row. Its header return action appears only when the sidebar is hidden; **Open … as a tab** sits in the header without a second banner. Files remains a panel toggle rather than another selected page. Overview uses the same Pin action as the project list, with title and actions stacked in narrow panes. Narrow week/month calendars expose horizontal scrolling without changing the selected calendar mode.

![Responsive Overview actions and separated Workspace navigation, with synthetic content](workspace-refinement/overview-responsive.png)

The pane's `+` menu creates a chat, opens files or a browser. Project task selection and creation stay in the overview's list/detail layout (detail with a back button on narrow windows). **Open in workspace** explicitly promotes a task or review to a work tab. Pending task edits and unsubmitted notes prevent promotion until saved or cleared. Global task and workflow creation remain in their global areas. Sidebar chats can still be dragged into tab groups or any split edge, with the six-pane limit.

Task notes, failed text edits and in-flight writes survive closing an inline detail, changing filters and leaving the project or global Tasks view. Drafts remain in memory for the current window and warn before closing it; they are not disk recovery drafts. Background refreshes preserve local edits, and returning during a note submission or upload cannot submit it twice. A global task request no longer changes a hidden project task selection. Document/source links in a standalone review explicitly target its project workspace.

## Opening profiles and previews

The header's **View** menu offers:

- **Chat & documents**, the default: chats prefer one side and other content the opposite side. The preferred chat side is configurable.
- **Free workspace**: new content uses the last active group, or a group to its right when requested.

Explicit destinations and already-open tabs take precedence. A profile change never rearranges existing tabs; manual dragging can mix any content. Automatic splits require at least 800 CSS pixels in the actual work area, create at most two columns and respect the six-pane cap. At capacity, a click opens a tab instead of silently failing. Resize measurements do not write the persisted layout.

One clean file/task preview per group is reused during browsing. Editing, double-clicking the tab, **Keep open**, or dragging pins it. Before replacing a preview, the store also checks registered dirty state, independently of input events. Opening choices and preview slots persist with the project layout; detached windows retain their own state.

![Free workspace opening options, with synthetic review and Markdown content](workspace-refinement/opening-profiles.png)

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
| `pnpm --filter @legalwork/app test` | 955 passed, 0 failed |
| `pnpm --filter legalwork-server exec bun test src/session-message-queue.test.ts src/session-read-model.e2e.test.ts src/artifact-files.e2e.test.ts` | 27 passed, 0 failed |
| `pnpm --filter @legalwork/desktop test` | 195 passed, 1 skipped, 0 failed |
| `pnpm --filter @legalwork/app typecheck` | Passed |
| `pnpm --filter legalwork-server typecheck` | Passed |
| `pnpm --filter @legalwork/desktop typecheck:electron` | Passed |
| `pnpm --filter @legalwork/desktop check:electron` | Passed, 110 bridge methods |
| `pnpm --filter @legalwork/app test:i18n` | 5,524 keys complete in English and German |
| `node scripts/i18n-audit.mjs --ci` | Passed |
| `pnpm build:ui` | Passed, existing bundle-size warnings |

Interactive checks used `/session-preview.html?unified=1` with synthetic documents and no connected services:

1. Open project Tasks and create a task: the list and detail stay outside the work tabs. Type an unsubmitted note, visit Calendar and return: the note survives. **Open in workspace** refuses while the note is pending; clearing it allows promotion.
2. Edit a Markdown preview, visit Calendar, return through Workspace and use Undo. Verify the draft, tabs and editor history survive. A clean preview is replaced by another file; a double-click pins it. Test the View profiles and retained selection, plus narrow task navigation at a 900-pixel window. Global workflow creation remains in its library.
3. Drag a sidebar chat to a split edge and verify the existing pane stays in place.
4. In two browser windows, open the same Markdown file. Check Cancel, Save, and Keep a copy during dirty handoff; verify the first window pauses while the choice is open and only one editor remains writable.
5. Repeat Keep a copy with the pinned DOCX editor and `apps/app/scripts/fixtures/legal-review.docx`: the receiving window opens the unchanged original, without the unsaved test prefix. Check individual document maximize/restore.
6. In an isolated Electron profile, open a task and DOCX in separate panes. Use the header's new-window button and verify both panes and active tabs transfer. Use the DOCX tab's context menu and verify the next window contains only that document, initially read-only.

Opening-policy tests cover both preferred chat sides, unmeasured/narrow work areas, existing and explicit destinations, free-mode reuse, native browsers, the six-pane fallback, dirty preview protection, pinning and persistence. Review navigation was also checked through Calendar and back before explicit promotion to the workspace.

Two Astra adversarial reviews covered the opening-policy code and the UI/user journeys. Follow-up browser checks verified narrow Overview layout, Pin labels, Files selection, the sidebar-hidden Workspace return, review source opening, and an unsent task note surviving detail close/reopen and a real project switch. Twelve added draft tests cover failed writes, background reconciliation, overlapping requests, note/upload duplication, hidden save completion, scope isolation and StrictMode lifetime handling. A title with surrounding whitespace was checked through blur and subsequent workspace promotion.

Queue integration tests use a real local HTTP server and a mock agent transport, covering shared reads, authentication, read-only servers, stale edits, archive restoration before dispatch, deletion, attachment persistence, lost acknowledgements and interrupted sends. No live model run or connected-storage publishing was performed for this change.
