# Local Assistant branch

On 2026-10-27, the native OpenCode v2 migration through `965885b3` was merged
into `codex/johannes-assistant`, preserving both histories. This includes the
shared managed configuration and removal of separate folder approvals. The
Assistant uses native session admission, message history, plugins and events;
cloud activation and VM/channel execution remain on the cloud branch.

`codex/johannes-assistant` is the desktop Assistant integration branch. On
2026-10-20 it was updated from `ffceada9` by merging `dev` at `14975365`,
preserving the existing branch history. Local improvements were selected from
`codex/legalwork-cloud-sync` at `aee752e8`.

## Included

- Existing local Assistant onboarding, daily conversations and history, reactions,
  project delegation, file handoffs, scheduled tasks, recorder controls and desktop
  notifications.
- Assistant appearance and notification preferences in normal Settings, with
  Account, AI Providers and Assistant first, and the neutral circle settings icon.
- Assistant identity and approval controls outside the movable document pane.
- Project-field defaults passed when creating the Assistant workspace.
- Bundled runtime schemas and owner-only runtime configuration files.
- Scheduled Assistant work in fresh child sessions, with only the final
  result returned to the daily conversation. Multi-step interactive research is
  routed to the native general subagent by the coordinator instructions.
- Current `dev` connector, browser, document, billing and workspace behavior.
  Browser network policy is checked before Assistant UI navigation permission;
  both restrictions remain enforced.

## Kept on the cloud branch

Cloud Assistant activation, account provisioning, VM and image lifecycle,
execution leases, personal cloud replication, mobile/WhatsApp/email channel
execution and transcript forwarding, cloud BrowserUse and the cloud connector
registry remain on `codex/legalwork-cloud-sync`. The local server has regression
coverage asserting that cloud activation and channel-history routes return 404.

Normal project/team sharing and local connectors from `dev` remain available.
The optional Apple Push transport already present in the original local branch
is retained; no VM or mobile channel runtime is added by this split.

## Validation and manual review

Run from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir apps/app typecheck
pnpm --dir apps/server typecheck
pnpm --dir apps/app test:i18n
pnpm --dir apps/app build
pnpm --dir apps/server build
pnpm --dir apps/app test
pnpm --dir apps/server test
```

Branch preparation uses CLI tests/builds. A rendered Electron walkthrough is still
required before release:

1. Open the Assistant, complete naming/appearance onboarding and send a local message.
2. Confirm reactions, history, project delegation and returned file cards.
3. Open Settings: AI Providers is second and Assistant third. Save appearance and
   notification preferences; verify there is no Cloud Assistant activation control.
4. Open a document beside the chat; verify the Assistant header and approvals remain
   usable. Check scheduled tasks still execute locally.
5. Exercise a connected Google/Microsoft account through the local tools using the
   normal connector setup from `dev`.

The full app suite has three Lexical initialization errors in
`markdown-block-editor`, `wiki-editor-outline` and `wiki-title-editor`; the same
three files fail on an untouched `dev` checkout with the same dependencies.
The server streaming-error test in `serve-node.test.ts` also fails on untouched
`dev`. The wiki graph polling test fails in combined runs and passes in isolation;
its implementation and test are unchanged from `dev`.

Final results: app 1,653 passed / 3 initialization errors; server 2,437 passed /
71 skipped / 2 failed as described above. Both production builds, both typechecks,
i18n completeness, 8 desktop notification/recorder tests, and the focused Assistant
and browser-policy checks pass. The built server CLI also starts under Node.
These are recorded separately; this branch split is not a release sign-off.

## Keeping the coordinator context small

Assistant schedules, including the morning briefing, run in a fresh worker each
time. The worker is linked to the daily chat through its parent ID, without
copying that chat's messages. Work can start while the main chat is busy; an
unfinished worker prevents overlapping repeats of the same schedule. Scheduled
permissions, wiki authority and an explicitly selected model remain enforced.

The existing durable delegation queue returns the worker's complete final response
and routing references, without character limits or truncation. It waits until the daily
chat is idle, survives restarts and avoids replaying results. Detailed records
and saved reports remain accessible from the worker and project files.

Validation includes 52 focused scheduling/Assistant tests, 5 existing HTTP/result
and queue tests, a live scheduler test with a busy main chat, and a fixture-model
test against the actual pinned engine. The latter verifies empty child history
and native general-subagent execution without forwarding parent context or raw
child tool results into the coordinator. No live model/account is used by these
tests. The subsequent full server run has 2,455 passes, 50 skips and the same two
unrelated failures recorded above.

Existing daily history is retained. This prevents future briefing-history
buildup; it does not retroactively compact today's old transcript or reduce the
separate baseline of system instructions and advertised tool schemas.

## Assistant behavior and project access

Settings → Assistant now contains additional instructions, searchable selections of
installed Plugins / Workflows / Skills, and project access: all, none, all except
selected, or only selected. The Assistant's own workspace stays accessible. New
projects are included in `all` and `exclude`; `include` and `none` refuse Assistant
project creation until the user changes access. Appearance and behavior save
independently. Preferences are local to this LegalWork server, like the current
local Assistant; they are not a new Clerk account isolation mechanism.

Only selected resource names, descriptions and exact references enter the
Assistant's conversation context. Selection does not install or enable packages,
connectors, or permissions. Workers load instructions in an isolated subagent or
allowed project session. Routing metadata is captured when settings are saved,
so replies do not rescan project libraries. Unavailable selections remain saved
and removable. Re-save selections after updating an installed resource to refresh
its captured description/reference metadata.

Additional instructions and routing preferences use the existing hidden app-state
reminder on the next turn, instead of changing the system prefix or replacing
history. System-transform text stays fixed for prompt caching. Results remain
uncapped.

The server enforces project policy on Assistant searches, reads, metadata edits,
calendar/file lookups, delegation, follow-ups, attention and shared files.
Linked recordings and scheduled project reads follow the same scope. Native
research children in the Assistant directory also run the tool guard. Restricted
modes refuse unscoped shell execution and generic cross-project task tools;
scoped Assistant tools and workers in allowed projects remain available.
Revocation suspends background result reads/delivery from denied projects, including
already queued notices. Only an owner/host may change behavior settings; the
managed agent's collaborator token cannot grant itself access.

This is an Assistant project policy, not an OS sandbox for installed plugins or
connectors. Existing desktop permissions still govern those integrations. A change
does not abort running project sessions or remove content already read into a chat.

Validation for these settings:

- `pnpm --dir apps/server exec bun test src/main-assistant.test.ts src/main-assistant.routes.test.ts src/assistant-settings.test.ts src/assistant-tool-access.test.ts src/assistant-delegations.test.ts src/assistant-scheduled-work.test.ts src/assistant-scheduled-work.routes.test.ts src/opencode-plugins/legalwork-assistant-tools.test.ts src/opencode-plugins/legalwork-scheduled-task-tools.test.ts`: 31 tests pass.
- `pnpm --dir apps/app exec bun test tests/assistant-behavior-settings.test.tsx tests/main-assistant-client.test.ts`: 5 tests pass.
- Library regression checks (`src/skills.test.ts`, `src/global-skills.test.ts`, `src/skill-composition.test.ts`): 27 tests pass. The combined settings/library run has 58 passes.
- The pinned-engine fixture test passes with 155 assertions after adding preference/access endpoints to its fake backend.
- Server build, app typecheck, and i18n completeness pass (6,994 EN/DE keys).

Manual review: open Settings → Assistant, save instructions and at least one
resource, then verify the next message uses them. Exercise each project access
mode, including a denied project read/delegation and a permitted one. Reopen
settings after restarting LegalWork to confirm persistence. Check keyboard labels,
search, scrolling and save feedback in Electron. Rendered UI review remains pending.

Resource selection UI follow-up: the three resource categories now use compact
rows with Add pickers and removable selected chips. Search/descriptions appear
inside each picker, and closed pickers do not mount their library lists. A live
Vite component preview with sample data verified search filtering, selection,
chip removal, Escape/focus return and save feedback. Six focused app tests, app
typecheck and EN/DE completeness pass. The production Electron screen receives
this change through the running dev server's hot reload; its real preferences
were not modified for the preview.

## Delegated session initialization

Delegated project chats use the normal authenticated session registration, bounded
MCP recovery and dispatch/deletion gate before their first prompt, queued follow-ups
and automatic returns. The managed engine forwards its verified source-session
context instead of treating its shared bearer token as the originating user's scope.
Durable work retains that permission ceiling across restart and respects subsequent
source/target downgrades, revocation and project restrictions. Existing chats without
saved authorization recover through an authenticated follow-up; unsourced legacy
queue entries pause until explicitly resumed.

Validation:

- `pnpm exec bun test apps/server/src/assistant-session-access.test.ts apps/server/src/assistant-session-queue.test.ts apps/server/src/assistant-delegations.test.ts`: 20 passed, including the real SDK queue executor after restart, legacy migration, permission changes and delivery deduplication.
- `pnpm --dir apps/server exec bun test src/main-assistant.routes.test.ts src/assistant-scheduled-work.routes.test.ts src/opencode-plugins/legalwork-assistant-tools.test.ts src/wiki/agent-access.test.ts`: 18 passed.
- `pnpm --dir apps/server typecheck`, the server build during Electron startup, and `git diff --check`: passed.

Live verification on 22 October 2026 restarted this checkout at
`http://localhost:5173` with the standard saved development profile. The Assistant
resumed the existing previously blocked project chat through `session_control`.
Both document skills loaded, the register and payout schedule were readable, and
native document tools created and inspected the requested Word table. The saved
DOCX passed ZIP integrity checks, contained 14 data rows plus its header, had no
unfilled placeholders, and retained 26 source links. The automatic return delivered
the file card and final result to the existing Assistant tab. Private project data
and the local verification screenshot are excluded from the repository.
