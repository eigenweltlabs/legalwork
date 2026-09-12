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

No live mailbox or regular development app was used. The already-connected Google account still needs the integration owner's live check. Final real-account certification for every provider and final design/integration review remain EIG-172/EIG-173/EIG-174 gates.
