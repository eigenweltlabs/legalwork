# Durable mutation and submission intent

[EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127/build-resumable-jobs-sync-checkpoints-and-an-action-journal). `MailActionJournal` is a worker-internal journal on an injected, already opened encrypted `MailDatabase`. It performs no provider calls, sends no messages, modifies no remote mail and retrieves no credentials. EIG-144/146 own those provider operations. Every operation is bound to the trusted constructor owner and a specific account.

## Dispatch and recovery contract

1. `enqueue(accountId, input)` records an immutable intent. `claim(accountId, leaseMs)` atomically takes one due action, increments its attempt count and returns its payload plus a UUID generation/token lease.
2. Validate provider binding, current credentials, permissions, payload references and conflict preconditions before dispatch. No external side effect is allowed while the journal says `running`. A known failure here may call `failBeforeDispatch(lease, retryable, retryAfterMs?)`.
3. Commit `markDispatched(lease)` **before** the first external side effect. The state becomes `dispatching`. Do not dispatch if the call throws or the lease has expired. `renew` may extend an active lease up to five minutes from the current clock.
4. `recordOutcome` accepts `succeeded`, `rejected`, `conflict` or `unknown`. Only a confirmed success becomes succeeded. Explicit provider rejection/conflict becomes failed; timeout, lost response or any ambiguous result becomes uncertain. Error text and provider responses are never accepted as journal diagnostics.
5. At restart and periodically, call bounded `recoverExpired(accountId, limit)`. Expired `running` leases are safe to retry because the contract forbids side effects before the dispatch marker. Expired `dispatching` leases become uncertain, for mutations as well as submissions. Neither `claim` nor duplicate `enqueue` ever requeues uncertain work.

There is an unavoidable ambiguity between committing the dispatch marker and the remote side effect. A crash there may yield uncertain even if nothing was transmitted; that conservative result prevents an automatic duplicate submission. SQLite cannot atomically commit with a provider. This is not an exactly-once delivery claim. Once a request might have left the process, its remote outcome requires reconciliation.

`reconcile(accountId, id, expectedVersion, 'succeeded' | 'failed')` settles uncertain work only after the caller has explicit evidence or a manual decision. It never resends. It cannot change a terminal action into retry. Any separately authorized new operation needs a new replay key and must account for the possible prior outcome.

## Replay, conflict and payload policy

Input fields are `kind: mutation|submission`, account-local `replayKey` (1–256 printable ASCII characters), `payloadJson`, nullable `precondition`, `conflictPolicy`, and optional `retry`. Payloads must be JSON objects at most 32 KiB in UTF-8, including syntax. They are opaque immutable intent descriptions, not executable code. Future adapters must validate their own operation schemas and resolve every message, draft or content identifier against the **claimed account**. Payload fields cannot override that account, provider, owner, credentials or transport. Store references rather than message bodies or attachment bytes; never embed access/refresh tokens.

The same replay key with byte-identical payload and identical kind, precondition, conflict policy and normalized retry policy returns the existing action in its current state. It never resets attempts or success. Any difference fails `replay_conflict`. JSON whitespace/key order is intentionally significant; callers should persist/reuse the exact serialized request. Keys are local idempotency keys, not a claim that a provider supports idempotent submission. Different accounts may reuse a key without sharing an action.

Conflict policy is explicit: `manual`, or `refresh_then_reapply` for mutations only. Submission requires `manual`. The journal always stops on a reported conflict. A future mutation executor may implement refresh/revalidation followed by a separately authorized new intent, respecting `precondition`; this metadata does not permit blind overwriting, automatic dispatch after an unknown outcome, or changing the saved intent. No last-write-wins behavior exists here.

Retry policy defaults to five attempts, one-second base and one-minute cap. Limits are 1–20 attempts, base at most one hour, cap at most one day and no smaller than base. Only safe pre-dispatch failures and expired pre-dispatch leases use exponential backoff, persisted as `available_at`. Claims consume attempts. Exhaustion is terminal failed. Provider rejection is terminal rather than assumed retryable. A safe pre-dispatch failure may supply a nonnegative provider minimum retry delay, which is persisted without shortening it to the local backoff cap. Retry timestamps saturate at the maximum safe timestamp; versions reject unsafe integer overflow.

## Cancellation, versions and diagnostics

`cancel(accountId,id,expectedVersion)` uses generation/revision CAS. Queued, retry and pre-dispatch running actions become cancelled; their old leases are fenced. Dispatching or already-uncertain actions remain uncertain with `cancelRequested=true`: cancellation cannot assert that a provider stopped processing. A late local result cannot overwrite this state using the old lease. Succeeded/failed/cancelled actions retain their terminal state. `read` and bounded keyset `list` return metadata only, including the explicit conflict policy, fixed last-error code and version. Leases are checked against owner/account, generation, token and current deadline in immediate transactions. A stale lease cannot dispatch, renew or record an outcome. This API is internal; it is not an archive-access gate or public payload API.

The journal does not log, export or enumerate secrets. Errors use fixed `mail_action_<code>` messages without driver/provider text, payloads or paths. One claim contains at most 32 KiB of payload. List/recovery batches are capped at 100 rows; their current internal SQL can read at most 100 bounded payloads, never the whole journal. Returned list metadata omits payloads and replay keys. There is no automatic pruning, so replay protection and uncertain records remain durable.

## Schema v5 and legacy recovery

Version 5 adds `mail_action_jobs` and account/state indexes in the existing migration transaction. The fast schema guard requires every new column. A failed migration rolls back table/index creation and the version update; retry is safe. Future schema versions are refused without reset or downgrade. Preserve the encrypted database, WAL/SHM as appropriate for a consistent backup, and its key; never delete an archive to resolve a migration error.

Existing `mail_actions` rows remain unchanged, including opaque payloads and historical running states. They are **never** selected by claim or recovery: their old state does not prove whether a side effect occurred. `legacyStatus(accountId)` exposes `unmanaged` and `unresolved` counts (all rows except historical succeeded count unresolved), so callers must not label an archive's journal fully handled while such records exist. No legacy import, replay or loss of data is performed. Draft/content references remain governed by existing conservative retention; the action journal does not collect published blobs.

## Synthetic verification

```sh
pnpm --dir apps/server exec bun test src/mail/storage/action-journal.test.ts
pnpm --dir apps/server exec bun test src/mail/storage/credentials.test.ts src/mail/storage/repository.test.ts src/mail/storage/content-store.test.ts src/mail/storage/consistency.test.ts src/mail/storage/sync-journal.test.ts src/mail/runtime/worker.test.ts
pnpm --dir apps/server typecheck
```

The launcher strictly compiles production TypeScript and runs 13 tests under actual Node and the production encrypted SQLite adapter. They cover payload encryption, duplicate request retention, competing-process enqueue/claim, owner/account isolation, size limits, retry budgets/backoff, lease renewal/expiry, cancellation, unknown outcomes, conflict policy, fixed-error rollback, v4→v5 migration rollback and legacy preservation. Separate child processes are SIGKILLed after committed running and dispatching boundaries, then the database is reopened and recovered. All fixtures use synthetic identifiers/payloads and random temporary keys. No live provider, delivery, mutation, remote cancellation or power-loss hardware claim is made.
