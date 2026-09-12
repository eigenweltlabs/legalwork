# Mail context menus (EIG-176)

Mailbox rows, rows in the Conversation view, and inline-search results use the shared Base UI context menu. Right-click, macOS Control-click, Shift+F10, and the Context Menu key open it. Arrow keys navigate its items; Escape or clicking outside closes it. Closing restores the row's focus without scrolling it into another position.

Invoking a selected row preserves its selected message set. Invoking another row selects that row alone. Multi-message menus contain bulk-compatible commands; reply/forward/open and filing stay single-message actions. Gmail exposes labels, other connected providers expose folder moves, and mixed-account selections disable that destination menu. Local archives display their read-only restriction. Permanent deletion opens the existing confirmation dialog, including Gmail's additional-permission explanation.

The menu calls the same enabled toolbar/reader buttons and destination select used by normal interactions. It creates no separate mutation API or action journal. Fresh provider preconditions, credentials, partial failures, pending-action disabling, and Undo remain owned by the existing command path. Shortcut hints come from EIG-175's common platform mapping.

The prepared selection is bound to its exact account/key/locator/precondition signature and the active reader identity. A changed selection, reader, or disappearing row closes the menu; invocation repeats that check synchronously. A notification or later selection cannot redirect an already opened menu onto another message.

Inline search resolves selected references through the existing authenticated reader API before exposing commands. Reads are sequential and bounded by the current result page. Every read checks cancellation and the selection generation before and after awaiting it. A new query/selection aborts the previous batch. The toolbar stays disabled while resolution is pending or failed. EIG-175's `mail-select-rows` event applies all current-page keys atomically, avoiding stale checkbox state during Select All or range selection.

## Focused evidence

`pnpm exec bun test apps/app/tests/mail-context-render.test.ts` runs the actual MailRoute, shared menu, search component and action toolbar in an isolated installed Electron profile against synthetic HTTP responses. `LEGALWORK_TEST_ELECTRON` optionally selects an installed executable. `MAIL_CONTEXT_EVIDENCE=/absolute/path` exports the screenshots.

The scenario covers selected/unselected rows, mixed Google/Microsoft selection, a partial queue failure and Undo, archive restrictions, deferred atomic search reads and exact journal targets, stale-menu A→B rejection, permanent-delete confirmation without deletion, label selection, storage/matter panel opening, paged and Conversation rows, keyboard invocation/navigation, macOS Control-click, Escape/outside closure and preserved scroll/focus. No provider or live profile is used. The EIG-175 owner additionally verified actual inline-search Ctrl+A and rapid range selection with deferred reads using this atomic interface.

The existing `mail-search-render.test.ts` regression also passes (filters, saved queries, paging, keyboard navigation, excerpts and stale request cancellation). Strict TypeScript checking of the new context-menu/action graph passes with the project aliases and one pinned Zod mapping. Adding the existing filing/search graph exposes an unrelated baseline TS7022 inference error at `mail-filing.tsx:16`; this is not reported as a passing whole-app typecheck. The actual combined renderer bundle compiles and executes.

[Ready-account mailbox capture](context-menu-evidence/mailbox.png) is synthetic and uses the shipped mail CSS plus installed Tailwind preflight and generated menu-layer utilities. [Single-message menu](context-menu-evidence/single.png) and [search menu](context-menu-evidence/search.png) also retain the deliberate action-failure evidence. These were visually inspected. No full app/platform suite ran. Native Windows hardware behavior and the final whole-shell density, checkbox visibility and typography review remain EIG-172/173/174 qualification.
