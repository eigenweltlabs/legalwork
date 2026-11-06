# Context-aware Assistant implementation

Implemented on `codex/assistant-launcher-upstream`, 23 October 2026. This records delivery against [the interaction revision](assistant-interaction-flow.md) and [the context/action extension](assistant-context-actions.md).

## Delivered behavior

- In-app desktop invocation opens the same native floating panel as the global shortcut. A full-width grip, reset control, per-display placement and bounded resizing keep it movable. Expansion returns to the originating LegalWork window. Browser-only invocation has a draggable fallback.
- The source window publishes its focused project/pane/chat, visible document, selected folder and supported selection. A foreign document keeps its source owner while the active project remains the execution destination. Focusing a chat retains the last visible document.
- Destination and source chips are visible. Switching destination preserves typed text. New invocations offer the new view instead of silently replacing an active draft; parked drafts remain available from Start.
- First project send binds or creates a real project session. An operation receipt and recovery marker prevent duplicate chats across concurrent requests, retries and restart. Existing project chats share the draft coordinator with the panel and main composer.
- The normal Assistant entry resumes the current conversation. Independent topics remain available under history. Start groups useful destinations, category browsing and creation/continuation actions; ongoing agent work has a labeled row rather than a permanent task-like toolbar icon.
- Ask is visible in every search category and names the destination. A search question is a separate submission from an existing conversation draft, including its attachments. An explicit `?` request is staged until Enter/Ask; empty results never submit automatically.
- Expanding search preserves its query and filters. Expanding a bound chat opens its exact session; expanding an unsent request transfers a draft without creating an engine chat. Draft contents travel through shared storage rather than a URL.
- Cross-project file Enter presents original-project / open-here choices. Open here uses the existing source-owned read-only tab. Same-project opening follows pane policy and uses durable tabs. A closed captured pane is reported rather than silently replaced.
- `doc`, document and localized aliases find files and expose a separate create action. Creation supports Markdown, text and Word, prefilled project/folder, or an existing same-format project document as template. Writes are exclusive, approved and journaled; collisions retain the form. Assistant drafting is explicit and uses the existing project agent/file-tool flow.
- Captured text can be explained, translated, rewritten, staged in an existing/new project chat, saved as an excerpt, or made into an editable task. Existing chat drafts are merged, not replaced. Tasks gain no guessed deadline. Saving keeps actual source metadata and the original passage.
- Answers can be copied, inserted through the existing origin adapter or saved to a project. Copy/move actions expose the destination folder and keep failed items available without rerunning successful items.
- Existing multi-file comparison, recordings, quick actions, shortcuts, screenshot capture, voice coordination and durable output recovery remain in place.

## Verification and capability boundaries

Validation on this revision:

- App: `pnpm exec bun test tests/launcher-*.test.ts tests/home-submission.test.ts` — 46 passed.
- Server: `pnpm exec bun test src/launcher-*.test.ts src/assistant-output.test.ts src/assistant-conversations.test.ts src/assistant-conversation-routes.test.ts src/assistant-submissions.test.ts src/assistant-submission-send.test.ts src/assistant-work.test.ts src/assistant-attention.test.ts` — 30 passed.
- Desktop: `node --test electron/launcher/*.test.mjs electron/host-approvals.test.mjs` — 33 passed.
- `pnpm --filter @legalwork/app typecheck`, `pnpm --filter legalwork-server typecheck`, `pnpm --filter @legalwork/desktop typecheck:electron` — passed.
- `pnpm --filter @legalwork/app test:i18n` and `pnpm --filter @legalwork/desktop check:electron` — passed; 138 bridge methods covered.
- `pnpm --filter @legalwork/app build` — passed with existing large-chunk/third-party annotation warnings.
- `git diff --check` — passed.

Regression tests cover source versus destination in split panes, direct project HTTP routing and write permissions, concurrent/restarted chat creation, preserved drafts on search-send/retry, document collisions and linked paths, Word structure, template copies and desktop context delivery. Type checks cover app, server and Electron; the production renderer build and shipped-language checks are included.

The real desktop startup also exposed a shared-schema import that the bundler accepted but Node could not resolve. It was corrected to the package export, with a Node-runtime regression test.

Native UI testing is deliberately left to the user as requested. The application is restarted after the change.

Context capture uses capabilities already available from LegalWork and the operating-system adapter. A file chip explicitly represents the saved file; arbitrary unsaved editor buffers, inaccessible selections and browser URLs are not invented. Full-page capture requires an actual provider; screenshot and selection remain distinct actions. Project creation/import choices currently use projects served by the connected LegalWork server; independently connected remote workers are not advertised as local write destinations. AI drafting stays in the conversation until the agent's file tools have saved an artifact; enqueueing a request is not shown as a successful save.
