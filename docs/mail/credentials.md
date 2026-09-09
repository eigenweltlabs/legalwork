# Encrypted account credential repository

EIG-126 storage foundation, 2026-09-09. `MailCredentialRepository` is a worker-internal, owner-bound repository on the existing encrypted SQLite connection. It performs no OAuth, provider calls, logging, browser launch, environment lookup or filesystem token export. It has no list method, worker command or public API.

## Binding and caller contract

Construct with `(database, trustedOwnerId, clock = Date.now)` only after `openEncryptedMailDatabase` and migration. Startup checks the v4 schema/FK setting and selected Multiple Ciphers engine, sqlcipher mode and MEMORY temporary storage. These checks reject stock/misconfigured backends; they do not independently prove a key was applied. The already-keyed production opener is mandatory; do not supply a plaintext or arbitrary SQL adapter.

The credential binding is `{ provider, clientId, authority, providerSubject }`. It must be derived from the dedicated OAuth settings and the provider identity verifier's **verified** result. Selecting fields explicitly avoids persisting email, display name or unverified ID tokens. Gmail authority is exactly `https://accounts.google.com`; its stable subject is Google's verified userinfo subject. Graph authority is `https://login.microsoftonline.com/<verified-tenant-GUID>/v2.0`, and subject is the verified Graph directory object GUID. Graph GUIDs/authority normalize to lowercase. Email is never the binding key. Every operation checks account ownership; every secret read/rotation also checks the complete binding and account provider.

The binding is immutable for the retained account, including across disconnect/reconnect. A different provider, client registration, authority/tenant or subject fails closed. Future client migration or account reassignment requires a separately reviewed operation. Gmail and Graph OAuth tokens are supported here; IMAP password/OAuth credential policy is not introduced by this slice.

## Versions, rotation and disconnect

`status(accountId)` returns only lifecycle state, archiveLocked and a version. Its query does not fetch token columns. Missing credentials are unconfigured/locked with version=null. Versions contain a random UUID generation and a positive safe-integer revision.

- `connect(accountId, binding, expectedVersion, tokens)`: expectedVersion=null only for the first credential row. A reconnect compares the current generation and revision, preserves the immutable binding, creates a fresh generation and increments revision. Reconnect requires explicit refresh replacement or clearing; it cannot inherit an earlier refresh token accidentally.
- `rotate(accountId, binding, expectedVersion, tokens)`: requires a connected/unlocked credential row and exact generation+revision. It retains generation and increments revision. Two refresh responses using the same snapshot have one winner; the other is stale and cannot overwrite the winner's token rotation.
- `disconnect(accountId, expectedVersion)`: CAS-checks the saved version, changes generation, increments revision, clears access/refresh tokens, expiry and grants, and persists disconnected/archiveLocked=true. It retains the account, identity binding, messages and content. Late refreshes fail while disconnected; after reconnect their old version remains stale.
- `readAccess(accountId, binding)` returns only access token, expiry, grants and version; expired access fails. `readForRefresh(accountId, binding)` returns refresh token, grants and version, including when access has expired. A missing refresh token fails explicitly. Both refuse disconnected rows and mismatched bindings.

Revision increments are checked against Number.MAX_SAFE_INTEGER; exhaustion rejects the write before changing tokens or state, with no wrap or reset. Generations are UUIDs, not counters. All mutations use the encrypted adapter's immediate transaction. CAS and writes occur inside that transaction on the serial writer; the test also verifies two separate Node writers serialize correctly.

Token input is `{ accessToken, expiresAt, grantedScopes, refreshToken }`; access must be nonempty bounded printable text with a future safe-integer expiry. `refreshToken` is explicitly `{ action: 'preserve' }`, `{ action: 'replace', value }` or `{ action: 'clear' }`, aligning preserve/replace with the provider refresh transport. Preserve retains the current value, including null; replace validates a nonempty token; clear stores null. No missing response field is silently interpreted as clearing. Connect/reconnect rejects preserve.

`grantedScopes` is always explicitly an array or null. Null remains unknown/unverified; requested configuration scopes are never substituted, and a rotation with null does not silently preserve an earlier grant assertion. The future integration must validate required actual permissions before provider operations. Refresh tokens, access tokens and grants are not authenticated provider identity by themselves.

Errors are fixed `mail_credentials_<code>` errors. SQL, validation and injected storage messages/causes are discarded, including token-bearing failure details. Token strings and snapshots remain caller-owned memory; JavaScript strings cannot be deterministically zeroized.

## Lock and revocation boundary

Persisting archiveLocked does **not** yet gate the existing content repository or stop a worker. EIG-123 integration must enforce this state before archive/content access and provider work, cancel in-flight operations, and discard prior in-memory credentials. This slice intentionally does not wire workers or APIs. Previously returned tokens may remain usable at the provider until expiry/revocation; clearing local credentials and CAS-fencing late results is not provider token revocation. Old encrypted WAL pages/backups can retain encrypted historical values; no physical erasure claim is made.

## Additive schema v4

One table, `mail_account_credentials`, with columns:

```text
account_id, provider, client_id, authority, provider_subject,
generation, revision, state, archive_locked,
access_token, refresh_token, expires_at, granted_scopes_json
```

account_id is the primary key. Its composite account/provider foreign key prevents mismatched account bindings. Connected/disconnected CHECK constraints require matching lock/token states. There is no credential/account deletion or content cascade in this API. The schema version update and table creation share the migration transaction. The fast schema guard now requires all credential columns; historical migration test fixtures remove v4 tables before constructing their v1/v2 layouts.

## Synthetic verification

```sh
pnpm --dir apps/server exec bun test src/mail/storage/credentials.test.ts
pnpm --dir apps/server exec bun test src/mail/storage/repository.test.ts src/mail/storage/content-store.test.ts src/mail/storage/consistency.test.ts src/mail/storage/sync-journal.test.ts src/mail/runtime/worker.test.ts
```

The launcher strictly compiles production TypeScript and runs nine tests under actual Node24.11.0 with better-sqlite3-multiple-ciphers13.0.3 on macOS arm64. Tests cover live DB/WAL absence of synthetic access/refresh/subject markers; reopened versions/tokens; account/provider/client/authority/subject isolation; explicit refresh preservation/replacement/clearing and null grants; disconnect/reconnect fencing with retained encrypted content; redacted write failure/rollback; revision overflow; and additive v3→v4 migration failure/retry/guard checks. Two real Node refresh processes contend on one saved version and yield exactly one durable winner. A new account and first credentials can be wrapped in one caller-owned database.transaction; nested connect rollback is tested to leave neither an account nor credentials after failure.

Existing repository/content/consistency/journal and actual Node worker suites pass against v4. The optional Electron worker test was skipped in this run because no explicit Electron executable was supplied. No real credential file, provider account, refresh request, keychain storage, signed app, content access gate or Windows/Linux qualification was exercised.
