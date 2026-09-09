# Durable sync page and job journal

EIG-127 foundation, 2026-09-09. Internal primitives on the existing encrypted SQLite connection; no provider executor, network transport, worker command, HTTP endpoint or sending/outbox implementation.

## Contract

Construct `MailSyncJournal(database, trustedOwnerId, clock?, retryPolicy?)` on the serial storage writer after migration. `clock()` returns safe, nonnegative integer milliseconds; default is Date.now. The owner never comes from a request. Every operation checks account ownership, including completion, failure, renewal and reclaim. A `SyncScope` is `{ accountId, scopeId, generation }`. Generations are explicit independent enumeration sessions: starting another preserves prior checkpoints/jobs. The future provider coordinator must choose the active generation and stop superseded work; this journal does not choose one or purge older work.

`readCheckpoint(scope)` returns `{ cursor, revision, discoveryComplete }`. A missing scope is `{ cursor: null, revision: 0, discoveryComplete: false }`, not evidence of an empty mailbox.

`commitPage({ ...scope, expectedCursor, expectedRevision, nextCursor, discoveryComplete, jobs }, persistMetadata)` atomically:

1. Checks account/provider and compares both expected cursor and revision. Rejects stale pages before invoking the callback. Revision increments even when nextCursor equals the old cursor, preventing same-cursor replay. A completed enumeration scope rejects further pages.
2. Runs the synchronous metadata callback with an account-bound writer: putFolder, ingestMessage, putContent and setAttachmentsEnumerated. No method accepts another account ID. The writer is revoked immediately when the callback returns; retained or asynchronous uses fail. Direct async functions are rejected before invocation, and returned thenables roll back. Reentry into this journal instance is rejected during the callback.
3. Persists every discovered download job and associates it with this scope; message foreign keys require its metadata to exist in the transaction. Inserts a job only once for `(account, kind, canonical provider message key, part ID, generation)`; overlapping Gmail labels/scopes share the same job. Raw/body and individual attachment jobs remain distinct, and identical provider IDs across accounts or generations remain distinct.
4. Commits the new checkpoint in the same transaction. The cursor cannot survive a callback/job failure while its metadata/jobs are rolled back. A replay of the already committed page is rejected; the caller reads the durable checkpoint rather than automatically replaying.

Jobs accept raw/body/attachment kinds only, a validated Gmail/Graph/IMAP locator, and an attachment part ID only for attachment jobs. IMAP keys include mailbox and UIDVALIDITY. There are at most 1,000 jobs per page; claim/reclaim batches are at most 100. The metadata callback itself is trusted internal code and must bound its work. It must use the supplied writer and perform no network I/O. Captured independent database/repository handles cannot be revoked by this API and must not be used to escape the callback contract.

The v3 journal uses mail_sync_scopes; the older, unused mail_cursors table is preserved, not silently imported or treated as a second authoritative sync position. Provider integration must use the journal checkpoint API.

## Leases, retries and recovery

`claim(scope, limit=10, leaseMs=30000)` first reclaims at most 100 expired leases in the owned account, then returns eligible jobs for the requested scope/generation. Each attempt gets a new random UUID lease token, increments attempts and has a bounded 1–300,000 ms lease. A shared job cannot be claimed simultaneously through a second scope. `renew(accountId, jobId, token, leaseMs)` extends only an unexpired matching lease.

`fail(accountId, jobId, token, retryable)` accepts only the current unexpired lease. A retry enters retry state with exponential delay, capped by the persisted policy; permanent failure or exhausted attempts enters failed. `reclaimExpired(accountId, limit=100)` applies the same budget/backoff for lost attempts. It clears the old token, so an old process cannot complete a newly claimed attempt. The retry policy is stored per job at discovery and survives restart: default 5 attempts, 1,000 ms base delay, 60,000 ms maximum delay. Configuration bounds are 1–20 attempts, base 1–3,600,000 ms and maximum base–86,400,000 ms. No jitter or scheduler is implemented. A wall-clock rollback may postpone reclaim; callers/tests can inject a controlled clock.

`succeed(accountId, jobId, token, persistResult)` runs a synchronous account-bound result callback and terminal state update in one transaction. The lease is checked before and after the callback; expiration during the callback rolls back its writes. Succeeded and failed jobs are terminal; page dedupe does not reset them. Recovery of terminal failure is a separate deliberate coordinator policy, not an automatic retry loophole.

`status(scope)` returns the checkpoint and queued/running/retry/succeeded/failed counts. **Job success does not attest to downloaded bytes.** The content repository's independently verified publication/manifest completeness remains authoritative. Explicit empty discovery requires a committed page with discoveryComplete=true and no jobs. Child attachment discovery after enumeration requires its own discovery scope or a future bounded enqueue transaction; no executor or implicit child-job creation is shipped here.

## Schema v3 integration

Additive migration creates these tables; existing content/message tables remain unchanged:

| Table | Columns |
| --- | --- |
| mail_sync_scopes | account_id, scope_id, generation, cursor, revision, discovery_complete |
| mail_sync_jobs | account_id, id, kind, message_key, part_id, generation, state, attempts, max_attempts, retry_base_ms, retry_max_ms, available_at, lease_token, lease_until, last_error |
| mail_sync_scope_jobs | account_id, scope_id, generation, job_id |

Scope primary key is account/scope/generation. Jobs have account/id primary key and account/kind/message_key/part_id/generation dedupe key. Account/message and account/job/generation composite foreign keys prevent cross-account or cross-generation associations. Due/expiry indexes support bounded selection. Only fixed retryable/permanent/lease_expired error categories are persisted, never provider error text or credentials.

The consistency schema guard must include these column maps and classify prior versions 1 and 2 as upgrade-required. Version and DDL changes share the existing transaction; v2 data survives upgrade, injected migration failure leaves version2 and no partial v3 tables, and future versions are rejected without downgrade.

## Verification and limits

```sh
pnpm --dir apps/server exec bun test src/mail/storage/sync-journal.test.ts src/mail/storage/repository.test.ts
```

The Bun launcher strictly compiles the production modules and launches Node's test runner with the real encrypted adapter. Eleven Node tests cover page replay/dedupe, account/provider isolation, raw/body/attachment identities, metadata/FK rollback, 1,000-job bound, claim/reclaim bounds, thenable rollback and delayed-writer rejection, fenced renewal/completion, persisted backoff/max attempts, terminal outcomes, explicit empty enumeration and v2 migration failure/retry. SIGKILL tests terminate the sole open writer inside metadata persistence, immediately after page commit and after claim; fresh processes recover an all-or-nothing checkpoint/job set and fence a killed worker's old lease. Synthetic metadata is absent from the physical encrypted database bytes.

Executed on macOS arm64 with Node24.11.0 and better-sqlite3-multiple-ciphers13.0.3. No real mailbox, provider download, byte-completion, 100k workload, network retry, hardware power-loss, disk-full or multi-writer performance claim follows from these tests. No provider cursor format is interpreted or sent to a network endpoint by this module.
