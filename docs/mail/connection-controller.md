# Worker-local mail connection controller

`providers/connection-controller.ts` combines private OAuth, authenticated identity discovery and the v4 encrypted credential repository. It exposes no HTTP route, worker protocol command, browser launcher or token DTO. The caller constructs it only inside the trusted mail worker with an already keyed, migrated database and an owner derived from server authentication. Close the controller before closing that database.

## Methods

`new MailConnectionController({database, ownerId, oauth?, identity?, lifetimeMs?, retentionMs?, maxRetained?})` accepts trusted test seams for OAuth/identity. They are not remotely configurable. Defaults are five minutes total flow lifetime, ten minutes terminal status retention and 32 retained flows. Lifetime accepts integer 10 ms–10 minutes, retention 10 ms–24 hours, and capacity 1–128. Invalid bounds fail before work. At most one active flow per provider is allowed; its slot is reserved before asynchronous OAuth listener startup.

`begin(settings, {reconnectAccountId?})` returns a promise for `{connectionId, authorizationUrl, expiresAt}`. The caller can explicitly open the authorization URL in the system browser. Connection IDs are random UUIDs; authorization URLs and settings never appear in polling status. Installed-app settings are snapshotted before asynchronous work. `poll(connectionId)` returns one of:

- `{connectionId, expiresAt, state: "pending" | "verifying" | "cancelled" | "expired"}`
- `{connectionId, expiresAt, state: "connected", accountId, renewable}`
- `{connectionId, expiresAt, state: "failed", error}`

`cancel(connectionId)` settles an active flow as cancelled and awaits bounded listener cleanup. Terminal cancellation is idempotent. `close()` prevents new flows, cancels all active work and waits for bounded cleanup; repeated close is safe. Late startup, OAuth or identity results are fenced from persistence. Terminal statuses contain no tokens or identity metadata and are pruned lazily after retention on begin/poll. The retained map is capped even if clients never poll. Unknown or pruned IDs return not_found.

## Atomic ownership and reconnect

After OAuth completes, actual grants must include Google's openid/email (including its userinfo.email alias)/gmail.modify, or Graph User.Read/Mail.ReadWrite/Mail.Send (plain or Graph-resource-prefixed). Graph access-token metadata need not list OIDC/profile/offline_access scopes. Requested configuration is never substituted for actual grants. Missing permissions yields permissions_missing before identity discovery or account creation.

Identity discovery supplies authority/providerSubject. New IDs are `mail_` followed by SHA-256 of the JSON tuple `[ownerId, provider, authority, providerSubject]`; clientId and mutable email are deliberately outside this identity tuple. A matching existing account returns reconnect_required. It never silently overwrites credentials or creates a duplicate for a changed registration.

New-account creation and credential connect occur inside one synchronous database transaction, using a nested credential savepoint. An identity, credential or persistence error leaves no new account. The deadline is checked before the transaction and again before commit. The account list display name comes from discovered displayName, or its checked email when absent.

Explicit reconnect reads the owner-scoped credential version before consent. Unconfigured/foreign/missing archives cannot be attached to a new identity. After discovery, credential connect validates the immutable provider/clientId/authority/providerSubject binding and compares the captured generation/revision. A disconnect, refresh rotation or competing reconnect during consent fences the stale result. The existing account is retained on failure.

Missing refresh tokens on a successful new consent explicitly clear old refresh credentials during reconnect; they never inherit a previous authorization's refresh token. Connected status reports renewable=false in this case. renewable=true reports a returned refresh credential, not a promise that the provider will accept it indefinitely. Account creation does not start sync, claim mailbox completeness or validate provider licensing.

## Error and secret handling

All errors are fixed codes: configuration_invalid, provider_busy, capacity, closed, not_found, account_not_found, reconnect_required, binding_mismatch, stale_credentials, permissions_missing, cancelled, expired, authorization_failed, identity_failed or persistence_failed. Polling distinguishes cancelled/expired from failed. OAuth denial is authorization_failed; raw provider/storage exception text never escapes. Expiry during listener startup rejects begin with expired. Reconnect conflict errors expose no foreign-account or provider identity values.

Access/refresh tokens pass only between trusted in-process OAuth/identity/controller code and the encrypted credential repository. The controller has no token getter and never returns, persists or logs an unverified ID token. It does not revoke provider credentials, mutate the existing Workspace OAuth registration, or close the caller's database. As elsewhere in JavaScript, in-memory strings do not provide guaranteed zeroization. Trusted injected operations must honor cancellation for resource cleanup; late results are still rejected even if a test seam ignores it.

## Evidence

```sh
pnpm --dir apps/server exec bun test src/mail/providers/connection-controller.test.ts
pnpm --dir apps/server exec tsc -p tsconfig.json --noEmit
```

The Bun harness builds the production controller and runs 13 tests in actual Node against the real encrypted SQLite adapter/schema v4. Tests cover successful encrypted persistence and secret-free status, deterministic duplicates, explicit reconnect, immutable identity/client binding, disconnect/CAS races, foreign/unconfigured account rejection, atomic rollback on an injected database trigger failure, consent/identity cancellation, late listener startup, close, expiration/capacity/retention, permission checks, absent refresh credentials and redacted failures. Provider OAuth/identity are trusted synthetic seams; no browser or live provider HTTP was used.

Root integration still owns worker commands, trusted settings loading, host-token-protected service routes, browser initiation and account lifecycle presentation. No live mailbox consent or synchronization is claimed by these tests.
