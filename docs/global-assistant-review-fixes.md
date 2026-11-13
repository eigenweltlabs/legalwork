# Global Assistant review fixes

This describes the corrections to fork PR #2 after the implementation review of `10229aa434bfd4f41ea9aa570eedd57bd1de84d9`. The product direction remains the [unified Assistant proposal](proposals/global-assistant-launcher.md): one callable window and search bar across Home, desktop, companion and Raycast. Fixing the reported defects does not mean the entire proposal has passed acceptance.

## Corrected behaviour

| Review | Correction |
| --- | --- |
| F01: stale windows overwrite drafts | The desktop serializes compare-and-swap writes against an authoritative file version. Browser writes use the Web Locks API. Every update checks the persisted editor lease and draft revision; broadcasts are notifications, not write authority. Uploads and sends protect ownership, including overlapping operations. |
| F02: conversation context leaks | Binding another conversation resets text, attachments, target and search scope before adopting its complete draft, including an empty draft. |
| F03: Home bypasses identified submissions | Home and the panel use `submitAssistantDraft` and the same server submission route. Normal Home sends retain the durable message queue, edit/reorder/stop, frozen context and the exact engine message ID. Home synchronizes uploaded file references, mentions, pasted text and preferences. Explicit shell commands retain their separate shell execution path. |
| F04: ambiguous delivery clears input | Unconfirmed sends retain the frozen operation and identity. Retry uses that operation; definite refusal remains editable. Acknowledgement clears only the submitted draft, preserving newer text in both surfaces. Concurrent command retries reuse one project session. |
| F05: output follows the latest origin | Automatic output retains the originating invocation's ID and selects the completed reply by its parent message ID. Reopening from another application cannot retarget insertion; native validation falls back to copying. |
| F06: capture falls back to another window | Window capture requires one exact title match. A missing, renamed or ambiguous source fails without taking an arbitrary window screenshot. |
| F07: transfer escapes destination | Destination components reject symbolic links/junctions and are checked again after approval. Copy and Move use exclusive creation; a file appearing during approval is not replaced. Source deletion follows successful copying. |
| F08: commands become plain chat text | Slash commands use the engine command endpoint with their arguments, files and preferences. Project commands get a tracked project session. Skills produce an explicit skill-loading instruction; quick actions retain their configured skill/command. |
| F09: Windows origin scripts fail | Foreground process IDs use a separate typed variable instead of PowerShell's protected `$PID`. |
| F10: older jobs disappear | Work derives status before filtering and pagination. App and Raycast follow all pages; a running job beyond the first 140 entries is covered by a route regression test. |
| F11: invocation ordering loses context | Invocation handling awaits conversation adoption, staged context and a fresh action catalog before dispatch. A newer invocation received during processing is handled afterward. |
| F12: Raycast does not typecheck | The extension consumes shared launcher contracts, declares React types and has a standalone lockfile, typecheck and build workflow. |

Additional corrections: file results render independently of slow task/chat providers; providers have actual timeouts even if they ignore cancellation; the initial file index is searchable while it grows; saved searches retain and reset type/date filters; the global attention list includes older Assistant conversations; tool steps no longer count as completed answers and release a project constraint early. Waiting or reordered Home queue entries do not override the request currently running.

## Verification of these changes

81 focused tests passed: 16 app tests, 41 server tests and 24 desktop tests. The server tests include real route handlers, a mock engine over HTTP, persistent queue restart/edit behaviour, concurrent retries and approval-time filesystem changes.

From the repository root:

```sh
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app build
pnpm --filter @legalwork/app test:i18n
pnpm --filter legalwork-server typecheck
pnpm --filter legalwork-server build
pnpm --filter @legalwork/desktop typecheck:electron
pnpm --filter @legalwork/desktop check:electron
```

These pass; the translation check covers 7,430 keys in both shipped languages and the desktop bridge covers 135 methods. The app build still reports large-chunk warnings.

From `apps/app`:

```sh
bun test tests/launcher-draft-coordinator.test.ts tests/launcher-submit-draft.test.ts tests/launcher-query.test.ts tests/launcher-keyboard.test.ts tests/launcher-search-session.test.ts tests/launcher-voice-coordinator.test.ts
```

From `apps/server`:

```sh
bun test src/assistant-conversations.test.ts src/assistant-conversation-routes.test.ts src/assistant-submissions.test.ts src/assistant-submission-send.test.ts src/assistant-work.test.ts src/assistant-attention.test.ts src/launcher-actions.test.ts src/launcher-context.test.ts src/launcher-file-index.test.ts src/launcher-preview.test.ts src/launcher-search.test.ts src/launcher-route-regressions.test.ts src/session-message-queue.test.ts
```

From `apps/desktop`:

```sh
node --test electron/launcher/*.test.mjs electron/host-approvals.test.mjs
```

From `apps/raycast-legalwork`:

```sh
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
node node_modules/typescript/bin/tsc --noEmit
./node_modules/.bin/ray build -e dist
```

Raycast installation, typecheck and build pass. The full application test suite was not rerun for these fixes; earlier results and their Bun/Lexical failures in `global-assistant.md` are historical, not a fresh green full-suite claim.

## Remaining acceptance work

- Real engine and desktop flows: global keypress through focused panel, macOS Spaces/fullscreen, native selection/insertion, recording and dictation handoff, window capture permissions, sleep/wake and Windows foreground/mixed-DPI behaviour. No new end-to-end video was captured: this verification used isolated route/SDK tests and builds, not a running permission-enabled engine/desktop session. Existing screenshots and timings predate these fixes.
- Real Raycast cold start, selection and focus handoff. A successful extension build is not a runtime test.
- Additional searchable folders are implemented in the [folder/drop/output follow-up](assistant-folders-drop-recovery.md). Remote/connector search providers, recording transcript search and full Assistant conversation content search remain feature work. Remote sources currently report their limitation.
- Panel drag-and-drop and durable automatic-output continuation are implemented in the [folder/drop/output follow-up](assistant-folders-drop-recovery.md). Screenshot crop/annotation remains feature work. Native origin validation uses process/window-title information, not a persistent OS control identity.
- Measure keypress-to-editable-panel latency including origin capture and global attention latency with large histories. File watcher changes still trigger background rebuilds rather than individual entry updates; paginated Work/attention reads may inspect substantial history.

For a manual acceptance pass, start the development desktop with `pnpm dev:electron` and a working engine, then: (1) compose text, a file and a paste in the panel and expand to Home; (2) switch to an empty conversation and verify no context follows; (3) send from Home while another turn runs, edit/reorder the queued item, then repeat with an interrupted connection; (4) invoke a selection-based quick action through Raycast on cold start; (5) switch from application A to B while the first action runs and verify its output cannot paste into B; (6) rename/close the capture source and verify no unrelated window is captured. Test the same draft and voice transitions in both directions.
