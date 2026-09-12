# Automatic connection sync (EIG-167)

Connection previously persisted OAuth/IMAP credentials without starting a provider worker. Worker reopening also left durable runs inactive, and the reader only polled the selected account's counters without reloading messages. Onboarding explicitly instructed users to press Resume.

OAuth now calls the worker lifecycle after the account/credential transaction commits. IMAP uses the same lifecycle after secure discovery and credential persistence. Each account owns an idempotent provider session, so connecting a second account cannot be rejected by another account's active session. Reconnect closes the prior session before resuming with the replacement credentials. Disconnect fences publication without manufacturing an explicit user pause.

Opening the local service loads trusted settings for connected accounts and resumes their existing provider runs. Existing durable `paused` states remain paused; active, interrupted and new accounts start automatically. Provider retry deadlines and checkpoints remain authoritative. IMAP reconnect retains folder enumeration checkpoints rather than resetting its generation. No schema migration is required.

Mail polls all visible accounts every three seconds and reloads messages when progress changes, keeping an open message selected. Sync progress, waiting, authentication/other errors and Retry/Resume appear in the unified inbox and account settings. Account settings no longer tells newly connected users to manually resume.

The Graph worker test additionally exposed a startup bug: the `inbox` well-known alias returns an immutable folder ID, which must be accepted just like `msgfolderroot`.

## Focused verification

Run from the repository root with pnpm:

```sh
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite runtime/connection-sync
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite providers/imap-backfill
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite providers/connection-controller
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite providers/personal-account
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite providers/graph-backfill --test-name-pattern 'actual Node worker and local service'
pnpm exec bun test apps/server/src/mail/service.test.ts
pnpm exec bun test apps/app/tests/mail-auto-sync-render.test.ts apps/app/tests/mail-onboarding.test.ts apps/app/tests/mail-accounts-settings.test.ts
```

The native connection test uses real OAuth loopback callbacks, the encrypted SQLite store, LocalMailService and its Node worker. All provider responses and credentials are synthetic. It covers Google message download, simultaneous accounts, Microsoft connection, duplicate announcements/start commands, offline restart, reconnect recovery and deliberate pauses. The IMAP service test uses its local TLS fixture and starts without a manual sync command. The Electron renderer test starts empty and verifies progress, automatic message arrival and Retry without navigation.

The Graph suite had a misplaced fixture statement at module scope. It now runs inside its legacy migration fixture; the startup test above is selected explicitly. Unrelated legacy migration tests and full platform/app suites remain for final integration.

Lead dev check on 12 September opened the regular profile and verified existing session history and today's Gmail arrival without pressing Resume. A real rate-limit response exposed exhausted discovery/download retry budgets, addressed by persisted account cooldowns. This is a targeted Google startup/recovery check, not full provider qualification. Final real-account certification for every provider and final design/integration review remain EIG-172/EIG-173/EIG-174 gates.


## Rate-limit recovery found in the dev account

Gmail account-level rate limits and transient outages now defer download jobs without
consuming their content-failure budget. The executor ends that batch and the account
waits at least a minute, or the longer provider Retry-After. Discovery keeps a bounded
cooldown after its quick retry budget. Both deadlines persist across worker restart;
explicit pauses and authentication failures still stop appropriately. Legacy raw
downloads exhausted by transient failures are requeued on restart when the persisted
account error indicates a provider outage. Permanent content failures remain visible.

Focused cases:

```sh
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite providers/gmail-backfill --test-name-pattern 'provider retry floor|rate limits enter|uncooperative discovery timeout|authentication rejection|download throttling|restart recovers legacy'
```

## Untyped Gmail history references

The connected dev account exposed a valid history record containing `messages[]`
without a specific add/delete/label event. The old parser stopped on that record.
The transport now prefers specific events and emits a reconciliation reference for
remaining message IDs, including mixed records. The engine reads current metadata
before committing the page: existing messages get current labels, unknown messages
get durable original-download jobs, and a fenced 404 retains any stored original.
A failed or interrupted read leaves the page cursor unchanged. Reads are sequential,
reference counts remain bounded, and collected snapshots are capped at 4 MiB.
Message history versions still prevent an older snapshot replacing newer state.

Google documents `messages[]` as changed references that may duplicate specific
change fields: [users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

Focused regressions:

```sh
pnpm exec bun test apps/server/src/mail/providers/gmail.test.ts --test-name-pattern 'history'
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite providers/gmail-backfill --test-name-pattern 'untyped history|history pages durably|pause/reopen between history|history checkpoint transaction'
```

Three parser cases and seven native encrypted-sync cases passed on macOS arm64,
using synthetic provider responses. These are feature checks, not full-provider or
platform certification.

Live dev verification after the fix: the previously stopped account reached
`complete` with 609 originals / 609 readable projections, zero pending or failed
jobs and no sync error. Its retained provider history was applied without sending
or deleting any provider mail. Existing session data was preserved.
