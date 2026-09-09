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

POST commands accept an empty body. Lists accept only `limit` (1–100, default 50) and optional `after`. SQL keyset pagination bounds row count, and the worker's 64 KiB response cap bounds encoded output. A single oversized row returns a fixed error; pagination never silently skips a row. Responses are marked `no-store`. Internal owner IDs, database paths, credentials and raw worker errors are excluded. Mail request paths are redacted in the normal request logger.

The service does not claim provider sync, message listing/search, draft editing, sending or mutations. `syncSupported` is explicitly false. Those operations need real implementations and separate typed protocol/API additions; there are no successful stub sync commands. Account rows will be created through verified provider connection handling, not an arbitrary public account-creation endpoint.

## Reviewed evidence and limits

The HTTP suite exercises the real server adapter with an injected test service: remote-token denial, disabled/shared listener absence, input rejection, lock/unlock, uniform account errors and native/ApiError redaction. Separate service tests use the actual built encrypted Node worker, including cancellation and shutdown. The desktop binding test uses the real built worker and an injected fake OS vault; it has also run against actual Electron 35.7.5. Key custody and ASAR tests provide additional independent evidence.

```sh
bun test apps/server/src/mail/routes.e2e.test.ts apps/server/src/mail/service.test.ts
pnpm --dir apps/server typecheck
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck:electron
```

This is a headless foundation; no new mail UI is exposed yet. Actual signed-app OS-vault behavior, release packaging on all target platforms, provider consent and live mailbox tests remain open. Tests use synthetic data only.
