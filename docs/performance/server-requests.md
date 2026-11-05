# Server request investigation — 23 October 2026

## Combined latest-dev integration — 28 October 2026

The migration branch is rebased onto dev `15b52ba2` and includes PR #329 at
`c6616c77`. The real Electron/React request fixture passes on the combined
source: 18 projects reconcile through one batch, live/reconnect/sidebar changes
remain visible, 100 event wakes never overlap group batches, and older-server
fallback remains available. The seven-second modern idle sample sends zero
individual group reads and zero reconciliation batches; this is a local fixture
measurement, not a WAN or real-model performance claim.

The new connected-calendar listener responds to its original sync topics and
resync, while queue/group/review/sandbox/dashboard-only events do not trigger
calendar/provider reads. The fixture verifies both event-burst isolation and a
subsequent real calendar refresh. Dashboard download/copy controls and retired
remote-registration boundaries are retained; manual LegalWork-server selection
still opens dashboards belonging to that selected server.

Reproduce with `pnpm --filter @legalwork/desktop exec electron scripts/request-performance-regression.mjs`.
This is a controlled request integration fixture. It does not replace complete
packaged-platform acceptance or establish paid agent/legal-quality parity.


## OpenCode v2 port — 27 October 2026

The current implementation uses `codex/opencode-v2-migration` as its base.
Native session/MCP readers and catalog readiness are preserved, as are v2's
queue-completion waiters, inbox schema, Office authentication, location guards
and disconnected-project startup. Queue changes also publish metadata updates.
Retired remote workspace registrations remain inactive; their former routing
and startup fixes are excluded from this port. Manual server connections retain
their selected connection credentials and transport cancellation.

The dated investigation and full-app/gateway results below describe the original
OpenCode 1.18.29 implementation. They are historical evidence, not v2 acceptance.
The v2 port reruns request regressions, native readiness/cancellation, queue
completion, wiki filtering, builds, and the Electron request fixture. No new paid
inference is part of this port.

With v2's generated engine inputs, checksum-pinned Node 22.23.4, and Bun 1.4.4,
the full app suite passes 1,753 tests, the full server suite passes 2,729 tests
with 113 skips, and the desktop Node suite passes 439 tests with four skips.
The final queued-refresh server-switch guard also passes its focused regression.
App/server builds and app/server/Electron type checks pass; the Electron bridge
covers 117 methods. The Electron request fixture and compiled Node benchmark
also pass (18 projects, eight event streams, 40 concurrent batch reads).

## Original investigation

The reported stalls have several confirmed amplifiers: overlapping reload polls,
per-project metadata traffic, repeated full session-list refreshes, duplicate
workspace-status reads, and remote desktop requests that outlive cancellation.
Metadata routes also invoked project filesystem checks and initial bootstrap.
Slow cloud-backed project folders could therefore hold up otherwise cheap reads.
Filesystem worker saturation is a plausible explanation for some historical
stalls, not a captured production profile of every stall.

The changes were developed on `codex/request-performance`, based on
`4cd058941a96752ce7aca97ea71c97341f56a84b` (`origin/dev`). The existing main
checkout and installed applications were preserved. No release was published.

Follow-up: the [real Electron dev-app verification](electron-dev-verification.md)
also exercises the full application, an independent remote worker, and a real
Eigenwelt subscription gateway. It found
and fixed remote-registry startup and Settings request-routing issues. Its fresh
validation results supplement the implementation-run counts below.

## Inventory and review coverage

Run `node scripts/request-inventory.mjs` to generate the local, Git-ignored
`tmp/performance/request-inventory.json` artifact. This is a source-site inventory,
not a count of unique runtime endpoints or a production traffic capture. It
contains 383 explicit request-wrapper calls, 134 query configurations, 58 interval
or serialized-poller sites, 372 direct route registrations, 128 fetch/bridge calls,
and 1,345 network-adjacent SDK/client call sites. Wrapper-generated routes,
computed query configurations and third-party SDK internals are not expanded.
Non-network timers and local client operations remain visible for auditability.

| Request family | Decision and resulting behavior |
| --- | --- |
| Session groups | One batch per server and authentication identity, up to 100 projects per chunk. Push-triggered refresh; 30-second reconciliation with metadata push, 3-second fallback otherwise. Initial/changed/reset states only. Older servers retain individual event reads after one capability probe per mounted connection. |
| Engine reload events | One request at a time; push wakes immediately, 30-second reconciliation or 3-second legacy cadence. Failure backoff, visibility pause and abort on cleanup. |
| Session inbox | Keep the 5-second background activity check: engine replies are not all represented in app metadata events. Serialize event/focus wakes, back off failures, abort cleanup. Detect removal/archive immediately; full project session-list reconciliation changes from 30 seconds to 5 minutes. |
| Project/session lists and snapshots | Preserve pagination, reconciliation, deletion detection and existing engine events. Concurrent identical JSON GETs share a transfer; later reads remain fresh. |
| Session/subagent status | The existing 2-second workspace status read feeds the subagent cache. Remove the second 5-second status request. Active execution monitoring retains its latency. |
| Message queues | Empty queues reconcile every minute while metadata push is live; queue changes invalidate immediately. Nonempty queues retain 1-second progress checks and the existing claim/renew protocol. |
| Provider/model refresh | Ordinary concurrent refreshes join per engine URL/project. Idle cadence changes from 15 to 60 seconds; pending reloads retain 15 seconds. Explicit forced refresh/reload actions queue and each execute. Server upstream discovery already has its own hourly limit. |
| Provider OAuth and connector sign-in | Keep active sign-in polling, existing in-flight guards and completion deadlines. These perform actions as well as reads; do not merge or cache actions. |
| Provider entitlements, usage and seat changes | Preserve existing cached/slow idle reads and faster pending checkout/reconnect checks. Generic concurrent GET sharing applies. |
| MCP status and management | Connected-count polling uses serialized requests with cancellation, hidden-window pause and backoff. Install, enable, probe and auth actions retain their behavior. |
| Sandbox metadata | Push invalidation plus 60-second reconciliation when supported; original cadence on older/disconnected servers. Execution, web and preparation actions retain their behavior. |
| Reviews | Push invalidates list/detail queries; completed details reconcile every minute. Running reviews and corpus searches retain 1-second progress checks. Read-like review POSTs do not emit change events, preventing invalidation loops. |
| Wiki suggestions | Push invalidation plus minute reconciliation, with original fallback. Review/save actions remain independent. |
| Saved views | Push invalidates list/definition metadata, with minute reconciliation and original fallback. Dashboard data retains its 15-second refresh because its data sources can change independently. |
| Wiki pages, revision, graph, contributions and project links | Preserve active external-file/sync change detection and current lightweight revision endpoints. These can change outside the API; metadata push does not cover all writers. Identical concurrent GETs still share. |
| Project/file/storage listings and read-only artifact previews | Preserve active external-file and remote storage checks, pagination, binary streaming and conflict/version checks. Hidden/inactive query behavior remains intact. |
| File writes, upload/download/transfer, Office checkpoints | Preserve actual operations and progress streams. Do not merge saves, transfer actions, locks, revisions or checkpoints. Large JSON reads use a progress-aware inactivity deadline rather than a fixed total duration. |
| Wiki data queries, review row queries, schedule previews | Explicitly marked read-only POST queries share identical concurrent inputs only. Different bodies/credentials remain separate. No retained response cache. |
| Project/task/firm sync, approvals and policy | Retain existing server events and fallback polling. Added metadata events reuse the same stream instead of opening another connection. |
| Scheduled tasks and calendar | Scheduled list/detail metadata uses push and minute reconciliation. Calendar external feeds and reminder claims retain their existing minute cadence. Reminder claims, task runs and writes remain actions. |
| Benchmarks, OCR, recorder, transcription and template generation | Preserve active job polling, existing in-flight guards, completion stops and progress streams. Local meter/elapsed-time timers are not server requests. |
| Health, engine/runtime info and reconnects | Retain existing health serialization/backoff and recovery behavior. Concurrent identical JSON health/capability reads share; no result cache can conceal a restart. |
| Analytics and Word add-in identity | Retain existing batched analytics flushing and separate add-in identity bootstrap. These do not cause per-project metadata fan-out. |
| OpenCode session/model execution and SDK streams | Preserve buffered SDK transport semantics for remote model turns. Forward cancellation across IPC; stream finite API JSON reads separately so body progress and deadlines work. No model actions, prompts or tools are deduplicated. |
| Remaining settings, plugins, skills, tasks, drafts, searches and management actions | Shared finite-JSON transport removes concurrent duplicate reads. User/agent mutations remain independent and invalidate pending read sharing. No speculative TTL cache or automatic action retry was introduced. |

## Server and transport changes

Registered-workspace metadata lookup validates registration and authorized roots
without stat/bootstrap. Reload events, groups and inbox use that lookup; actual
file operations retain directory checks/bootstrap and wiki file permissions.
Inbox still canonicalizes directories for correct symlink/database matching and
checks cancellation between operations. It is not claimed to be disk-free.

Wiki authorization uses one registry snapshot per request, never a cross-request
permission cache. Metadata avoids wiki file hydration; private-wiki list filtering
and access checks remain. Empty wiki registries skip project canonicalization.
Allowed CORS preflight responses can be cached for 10 minutes; actual requests
still authenticate and authorize normally.

The shared JSON transport joins only simultaneous safe reads. Its key includes
method, URL, body and both credentials. Each consumer parses its own mutable
value; failed requests are evicted; mutations break pending sharing; independently
cancelled requests do not share an abort controller. Deadlines cover headers and
stalled response bodies, resetting when chunks arrive so large progressing reads
remain usable.

Remote Electron requests now have owner-scoped request IDs and cancellation,
including while waiting for headers or buffering the body. Closing a window
aborts its requests and cannot cancel another window's request. Finite API GETs
use the existing pull-based stream bridge, avoiding browser connection-pool
contention with long-lived streams.

## Performance evidence

The real Electron/React StrictMode fixture mounts 18 projects, verifies local
group migration, remote changes, a burst of 100 event wakes, saved-view updates,
reconnect reconciliation, sidebar deletion and older-server fallback. The latest
7-second idle sample recorded zero group requests with metadata push; the legacy
fallback recorded 43 individual group-event requests (36 in earlier runs). Peak overlapping batch
requests during the event burst was one. Local groups migrated once.

For 18 projects, configured steady idle group traffic changes from approximately
360 requests/minute to 2 batched reconciliations/minute while metadata push is
connected (99.4% fewer). This is a cadence estimate, not a measured one-minute
production capture; actual changes add refreshes. Independently, batching alone
changes each 18-project reconciliation from 18 requests to one.

The compiled production Node server benchmark runs 20 rounds with 18 registered
projects, eight open event streams, and a burst of 40 concurrent batch reads. It
asserts that a cold existing project is not bootstrapped and missing folders are
not created. The recorded loopback timings are in the evidence JSON. They measure
the local fixture, not cloud latency or the historical iCloud stall.

## Reproduce and verify

From the repository root, using installed workspace dependencies:

```sh
node scripts/request-inventory.mjs
node apps/app/scripts/request-reload-regression.mjs
pnpm --filter @legalwork/app test
pnpm --filter legalwork-server test
pnpm --filter @legalwork/desktop test
pnpm --filter @legalwork/app typecheck
pnpm --filter legalwork-server typecheck
pnpm --filter @legalwork/desktop typecheck:electron
pnpm --filter @legalwork/desktop check:electron
pnpm --filter @legalwork/app build
pnpm --filter legalwork-server build
LEGALWORK_REQUEST_EVIDENCE=/tmp/legalwork-request-browser pnpm --filter @legalwork/desktop exec electron scripts/request-performance-regression.mjs
node apps/server/scripts/request-performance-node.mjs /tmp/legalwork-request-node.json
```

New regression tests cover duplicate GET/read-only POST transfers, independent
parsed values, mutation barriers, credential separation, failed-read retries,
stalled/progressing bodies, serialized event bursts/backoff/abort, IPC ownership
and cancellation, reload credential/cursor isolation, forced provider refreshes, cold/disconnected projects, batch
cursors and private-wiki visibility. The 20-concurrent-GET test was also run
against the original transport: it failed with 20 transfers; the changed
transport passes with one.

The baseline already has three app failures in Lexical editor initialization
(`markdown-block-editor`, `wiki-editor-outline`, `wiki-title-editor`) and two
server failures (Bun ended-stream handling and the wiki graph filesystem polling
test). Final results and exact commands are saved alongside baseline logs in the
local evidence directory. These pre-existing failures prevent claiming that the
entire repository suite is green or promising zero possible regressions.

| Full suite | Baseline pass / fail / skip | Final pass / fail / skip |
| --- | --- | --- |
| App | 1,653 / 3 / 0 | 1,670 / 3 / 0 |
| Server | 2,403 / 2 / 70 | 2,405 / 2 / 70 |
| Desktop | 381 / 0 / 4 | 383 / 0 / 4 |

The three app failures also produce three module-initialization errors; these
are the same failed test files, not three additional failing scenarios. App,
server and Electron type checks, app/server production builds, the 119-method
Electron bridge check, and both integration fixtures pass. Final full-suite
total: 4,458 passing tests; no newly failing tests detected relative to baseline.

## Debug report

- Symptom: slow requests and apparent stalls across installed, local and remote use.
- Root cause: overlapping polls and redundant per-project reads amplify slow
  filesystem-dependent metadata work; remote cancellation previously stopped
  waiting in the renderer without reliably stopping the underlying request.
- Fix: `request-poller.ts`, `legalwork-server.ts`, the shell sync hooks,
  `http-requests.mjs`, `routes/sessions.ts`, `server.ts` and the metadata query
  consumers implement serialized polling, shared reads, batching, push updates,
  request cancellation and lighter authorized metadata lookup.
- Evidence: baseline/final suites, original-transport failing regression,
  Electron fixture, actual reload-hook lifecycle regression and production Node
  benchmark described above.
- Regression tests: `apps/app/tests/request-sharing.test.ts`,
  `request-poller.test.ts`, the desktop transport tests, provider refresh tests,
  `apps/server/src/request-metadata.test.ts`, resource-change and wiki API tests.
- Related constraint: external files, inbox engine replies and active job
  progress still require reconciliation; a disconnected cloud filesystem remains
  an independent source of latency for genuine file operations.
- Status: **DONE_WITH_CONCERNS** — local fixes and targeted checks verified;
  baseline suite failures and a dev-window refresh issue remain. The full-app
  follow-up verifies local/remote fixtures and one real subscription inference;
  packaged behavior and production remote throughput were not measured.

Evidence for this investigation is saved at
`artifacts/legalwork-request-audit-20261023/` in the parent workspace, including
`verification.json`, baseline/final test logs, `node-performance.json`, browser
request counts and a screenshot. Historical `audit.json` is preserved as the
original report. Live production/remote throughput, a packaged release and
cloud-drive outage recovery have not been verified by this local change.