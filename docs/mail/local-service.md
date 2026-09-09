# Local mail service and API

The desktop creates one `LocalMailService` bound to the local profile's `desktop-local` principal and `app.getPath("userData")/mail/mail.sqlite`. This durable location is outside caches, workspaces and matter directories. Neither owner nor filesystem path comes from an HTTP request. The service and key callback are injected in process, separately from serialized server configuration. Standalone servers have no default mail service.

The service starts locked, with no native worker or OS keychain access. Explicit unlock loads the OS-wrapped key and starts a supervised Node/Electron worker. The worker authenticates the encrypted database and migrates it before readiness. Lock closes the worker and decrypted connection. Shutdown marks the service stopped before awaiting cleanup, rejects new requests and permanently prevents that instance from unlocking. Pending unlock cancellation cannot launch a late worker; any subsequently delivered key buffer is cleared.

## Initial versioned API

All endpoints require the desktop `X-LegalWork-Host-Token`. Remote owner, collaborator and viewer bearer tokens are insufficient. Routes are registered only for literal `127.0.0.1` or `::1` listeners with an explicitly injected service. When desktop sharing switches the embedded server to `0.0.0.0`, the old service is stopped and mail routes are omitted. A separate loopback listener will be needed if simultaneous sharing and mail is required.

| Method and path | Behavior |
| --- | --- |
| `GET /mail/v1/status` | Redacted locked/unlocking/ready/unavailable/locking/stopped state and protocol version |
| `POST /mail/v1/unlock` | Lazy OS-key retrieval and real encrypted worker initialization |
| `POST /mail/v1/lock` | Reject new work, stop worker and close storage |
| `GET /mail/v1/accounts` | Current owner's account summaries |
| `GET /mail/v1/accounts/:accountId/folders` | Owned account's folder/label summaries; missing and foreign accounts have the same 404 |
| `POST /mail/v1/connections` | Begin Google or Microsoft OAuth with trusted desktop configuration; return connection ID, authorization URL and expiry |
| `GET /mail/v1/connections/:connectionId` | Poll a redacted pending/verifying/connected/failed/cancelled/expired state |
| `POST /mail/v1/connections/:connectionId/cancel` | Cancel the local OAuth attempt and close its loopback listener |
| `POST /mail/v1/accounts/:accountId/disconnect` | Clear credentials, fence pending reconnects and retain a locked local archive |
| `POST /mail/v1/accounts/:accountId/sync/start` | Start or resume Gmail history using trusted desktop registration settings |
| `POST /mail/v1/accounts/:accountId/sync/pause` | Pause background work and revoke a pending start/publication |
| `GET /mail/v1/accounts/:accountId/sync` | Durable enumeration, original, projection, pending/failure counts and fixed error codes |

Connection creation accepts only JSON `{ "provider": "gmail" | "graph", "reconnectAccountId"?: "owned-account-id" }`, bounded to 8192 bytes with a two-second read deadline. Provider settings, credentials, owner and filesystem paths cannot be supplied through HTTP. Other POST commands accept an empty body. Lists accept only `limit` (1–100, default 50) and optional `after`. SQL keyset pagination bounds row count, and the worker's 64 KiB response cap bounds encoded output. A single oversized row returns a fixed error; pagination never silently skips a row. Responses are marked `no-store`. Internal owner IDs, database paths, credentials and raw worker errors are excluded. Mail request paths are redacted in the normal request logger.

The development desktop loads Google's installed-client JSON from the trusted main-process `LEGALWORK_MAIL_GOOGLE_CLIENT_CONFIG` environment variable. The loader requires a private owner-controlled regular file and directory on Unix and rejects symlinks, hardlinks, FIFOs and oversized input. Microsoft uses `LEGALWORK_MAIL_MICROSOFT_CLIENT_ID` and `LEGALWORK_MAIL_MICROSOFT_TENANT_ID` from that same trusted process. No registration is reused from a workspace. Distribution configuration and Windows ACL qualification remain separate work.

Only a verified provider identity and the required actual grants can create an account and encrypted credentials atomically. Cancel, lock and shutdown fence late completion. An operation epoch also rejects configuration loads started before lock/reopen or disconnect; an old begin request cannot obtain a fresh post-disconnect credential version. Disconnect retains metadata and content but clears tokens and locks folder/status access across worker restarts. Repeated disconnect rotates the durable generation, including when another controller is reconnecting. This does not revoke the provider grant remotely or purge retained content; the public privacy notice must be reconciled with this approved retention contract before pilot.

The service supports Gmail backfill (`syncSupported: true`): recent mail first, then all accessible history including Spam and Trash, with deduplication by account/provider message ID. Originals, body variants, inline images, embedded messages and attachments are eagerly stored in the encrypted database. Graph and IMAP synchronization remain unsupported. Accounts are created through verified provider connection handling.

Start and pause accept empty bodies. Registration settings and tokens stay inside the private parent/worker boundary. Start returns progress immediately; downloads run in the worker with one active account and one raw request at a time. Progress distinguishes enumerated, downloaded and projected messages from pending/failed jobs. Completion requires exhausted history pagination and durable current bodies/attachments for every discovered original. Limit, unsupported-MIME and missing-provider-content failures remain visible and retain the original. A reopened unfinished run reports paused until explicitly resumed; its cursor and jobs remain durable. Lock, pause, disconnect and shutdown revoke late publication.

Message listing/search, draft editing, sending and mailbox mutations still need their own typed operations. Current progress is a headless implementation surface; it does not establish live-provider or signed-platform qualification.

## Reviewed evidence and limits

The HTTP suite exercises the real server adapter with an injected test service: remote-token denial, disabled/shared listener absence, input rejection, lock/unlock, uniform account errors and native/ApiError redaction. Separate service tests use the actual built encrypted Node worker, including cancellation and shutdown. The desktop binding test uses the real built worker and an injected fake OS vault; it has also run against actual Electron 35.7.5. Key custody and ASAR tests provide additional independent evidence.

```sh
bun test apps/server/src/mail/routes.e2e.test.ts apps/server/src/mail/service.test.ts
pnpm --dir apps/server typecheck
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck:electron
```

This is a headless foundation; no new mail UI is exposed yet. Actual signed-app OS-vault behavior, release packaging on all target platforms, provider consent and live mailbox tests remain open. Tests use synthetic data only.

## Gmail backfill integration evidence

The real built-worker fixture follows recent and all-history Gmail pages, deduplicates messages across them, preserves Inbox/Spam/Trash memberships, eagerly stores and reads exact attachment bytes, and reopens with complete durable progress. The complete mail suite passed 156 tests with actual Electron enabled. Packaged ASAR worker, desktop binding, native unpacking and dependency-mirror checks passed. Independent review covered the engine, stream publication, stored projection and local API integration.

The current scope is full-history backfill. New-mail/history polling and remote removal/flag reconciliation belong to EIG-129; search and core client commands remain separate tickets. Default limits are explicit (64 MiB original, 32 MiB decoded attachment, 2 MiB decoded bodies); messages exceeding them remain incomplete with errors and retained originals where available. No live mailbox, actual send, signed-platform qualification or large-mailbox benchmark is claimed.
