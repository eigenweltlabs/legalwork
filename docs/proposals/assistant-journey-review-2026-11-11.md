# Assistant mini-bar and Raycast journey review — 11 November 2026

Scope: the existing launcher branch, including the standalone Raycast extension.
Three Astra reviewers covered navigation, files/native integration, and chat/output
flows, then independently reviewed one another's changes. Findings were implemented
between code-review rounds; automated checks were reserved for the final batch.
No live UI or computer-use testing was performed.

## Journeys and corrections

| Journey | Review outcome and changes |
| --- | --- |
| Search → choose exact result in Raycast → mini-bar | Preserve source and result identity through launch links; resolve it again before acting. Slow lookups cannot replace a newer invocation/navigation. |
| Local file → Finder/default app/clipboard | Raycast now offers native Open, Show in Finder and Copy File. Validate current visibility, source root, real path and file kind when acting. |
| Mini-bar file → drag to Finder | Added native drag for files/folders in results, recent items and nested lists. Prepare handles before the gesture; bind them to the renderer, expire them, revalidate paths, and consume the entire selection atomically. Remove consumed handles from the renderer cache immediately. |
| Incoming file drop → draft | Existing staging remains the input path; active saves block competing drops. Folder drops remain unsupported, with an explanation. |
| File/task/recording → Assistant or project chat | Raycast uses the same result-action dispatcher and project picker as the mini-bar. General Assistant and ordinary project chats retain their distinct access rules. |
| Resume project chat with BYOK | Registered project origin determines the target even when Assistant bootstrap is unavailable. |
| Chat draft → Work → same chat | Restore the saved draft explicitly before re-entering the composer. |
| Draft → different project/quick action/slash command | Preserve the source and destination drafts; unbind before choosing a new command target; freeze request/output identity across retries. |
| Mini-bar draft → app chat | Keep task references and explicitly handed-off selected text. Block handoff/archive while submitting or attaching files. |
| Selection/clipboard/screenshot → chat | Expire residual captured context; reject late captures after the destination changes. Project screenshots work without general Assistant access. |
| Approve/deny → failed response | Keep the approval visible and show a retryable error rather than removing it in a finally handler. |
| Quick action → automatic output | Desktop Copy/Insert intent survives failed retries with the new request identity. Web output lookup uses the exact request instead of the latest message page. |
| Browse project/folder → create | Seed the form with the browsed project/folder; retain Create alongside full document aliases. Folder confirmation ignores held Enter. |
| Sort/filter/actions → back | Preserve the browsed category when applying project scope; route keys to the active submenu; do not advertise action menus for unsupported command rows. |
| Hidden items → Restore all | Return keyboard focus to the entry when the last restore control disappears. |
| Task edit / document creation / transfer → pending save | Propagate form state, suppress competing actions/navigation while saving, and retain the native panel during mutations. Reuse a stable task identity on retry. |
| Quick-action settings → save | Pick an actual project, prevent edits during save, and preserve a newly created action if shortcut registration fails. Offer only implemented output policies and explain unsupported legacy choices. |
| Quick action → missing arguments/files | Collect missing inputs in a local form; Cancel preserves the draft. Stage files directly into the selected destination and submit separately without creating an extra Assistant conversation. |
| Approved file transfer → source changes | Recheck canonical path and file identity after approval and before removing a moved source. Preserve changed source files and report partial copies. |
| Code Mode reaction → restored chat | Fix an independently reproduced baseline projection defect: extract valid recorded nested reaction results as well as direct tool results. Cloud checkpoint storage is unchanged. |
| Restart app while Raycast stays open | Refresh pairing credentials for actions/searches, support the development scheme, and clear stale results/loading after cancellation. Work opens the exact job or origin conversation. |
| Stale task/chat/recording lookup | Correct the preview query schema; reject deleted tasks, ephemeral recordings, archived chats and chats from another project before reading messages. |

## Limits and manual acceptance

- The published Raycast List API exposes no custom drag-out handler. The external
  extension offers Copy File/Show in Finder; native drag is implemented in the
  LegalWork mini-bar. Raycast's custom list has no multi-selection or incoming
  file-drop flow here.
- Native Finder drops, icon/drag feedback, window focus/blur, OS selection access,
  and real Raycast cold starts still require hands-on acceptance. Unit tests can
  verify the handoff and path rules, not the operating system gesture.
- Multi-file drag uses the existing explicit multi-selection in search results;
  recent and nested navigation rows support dragging their individual item.
- Desktop automatic outputs use the persistent native queue. The web mini-bar
  still has one mounted automatic-output slot: concurrent actions or a reload
  can lose automatic delivery, while the reply remains available for manual
  copy. A durable web delivery queue is separate follow-up work.
- Startup of the real development profile reports invalid stored project-template
  field types from `GET /workspaces/project-templates`. The app/server start and
  other workspace endpoints respond, but project-template loading remains a
  separate configuration/schema issue. No user templates were modified.
- Preview and Copy Path remain deferred. The repository's broader deletion/DMS
  model is unchanged; launcher actions revalidate against existing visibility
  rules and live files.

## Validation

The final batch passed, with targeted reruns only for discovered failures or
newly corrected code:

- App launcher/link/client/copy suites: **113 tests passed**; the final missing-input
  helper adds **3 passing tests**.
- Server launcher, task, conversation, submission and output suites: **97 tests passed**.
- Desktop launcher suites: **47 tests passed**, including native drag handles,
  file clipboard, pairing, shortcuts, window lifecycle and output recovery.
- Raycast native-file helpers: **2 tests passed**; isolated extension typecheck
  and production build passed.
- App and Electron typechecks, server build, UI production build, IPC bridge
  coverage, i18n validation and generated-guide checks passed. The UI build
  retains existing large-chunk/dependency annotation warnings.
- Native Assistant execution and queue checks passed except a reaction projection
  assertion reproduced unchanged at the prior HEAD. A narrow extraction fix then
  passed the failing real-engine checkpoint case and focused channel regressions;
  no checkpoint persistence changes were needed.

Representative commands (from the repository root unless stated otherwise):

```sh
# From apps/app, with the repository's CI Bun version:
pnpm dlx bun@1.4.4 test tests/launcher-*.test.* tests/assistant-links.test.ts tests/main-assistant-client.test.ts tests/message-copy.test.tsx
# From apps/server:
pnpm dlx bun@1.4.4 test src/launcher-*.test.ts src/assistant-submissions.test.ts src/assistant-submission-send.test.ts src/assistant-output.test.ts src/assistant-conversations.test.ts src/assistant-conversation-routes.test.ts src/assistant-session-access.test.ts src/assistant-work.test.ts src/tasks-api.test.ts src/task-store.test.ts
# Native fixtures additionally require the verified prepared engine in LEGALWORK_TEST_OPENCODE_BIN.
node --test apps/desktop/electron/launcher/*.test.mjs
pnpm --filter @legalwork/app typecheck
pnpm --dir apps/server build
pnpm --dir apps/server exec tsc -p ../desktop/tsconfig.electron.json --noEmit
pnpm --filter @legalwork/desktop check:electron
pnpm --dir apps/raycast-legalwork typecheck
pnpm --dir apps/raycast-legalwork build
pnpm build:ui
pnpm --filter @legalwork/app test:i18n
pnpm docs:generate
pnpm docs:check
```

Live UI acceptance remains separate from these automated checks, especially the
Finder drag gesture, selection permissions, native dialogs and Raycast cold start.

The reviewed app was launched from this worktree after validation. Electron, Vite
and the local server started; Assistant/workspace requests returned HTTP 200.
