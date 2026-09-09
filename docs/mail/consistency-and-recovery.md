# Mail consistency diagnostics and migration recovery

`checkMailConsistency(database, { deep: false, maxRows: 100000, batchSize: 128 })` is an explicit, worker-only diagnostic over the injected encrypted `MailDatabase`. It is not wired to startup or public APIs by this change. It performs no migration, repair, deletion, reset, content download or schema-version update.

The result contains only `ok`, `scanComplete`, `scannedRows`, `contentHashesVerified: false`, and a sorted list of fixed issue codes. It does not return account IDs, message IDs, subjects, bodies, reference hashes, paths, SQL error details or offending database rows. Invalid options also produce a fixed code. The caller decides how to display an actionable recovery state without exposing mailbox data.

## What is checked

- SQLite `quick_check(1)` and a one-row-limited foreign-key diagnostic, plus whether foreign-key enforcement is enabled. The check never enables enforcement implicitly.
- Current schema version and the presence of required tables/columns. Missing schema, incomplete schema, v1 requiring migration and an unsupported/newer version produce distinct codes. A v1 database is not treated as a healthy current schema.
- Account declarations, canonical provider message keys/locators and account-provider agreement. IMAP identities must retain their own mailbox membership.
- Reference metadata and manifest part/state relationships. Any stored part or referenced draft lacking a published blob object is `unpublished-content`; an old v1 metadata reference is not proof that the bytes exist after upgrade.
- Published blob identity/reference relationships and indexed chunk metadata: contiguous ordinals, exact count, size, maximum chunk length and final-chunk length. Unpublished staging left by an interrupted writer is not treated as complete content or deleted by the diagnostic.

The check uses a single synchronous database transaction for a consistent view. The native implementation uses an immediate transaction, so this holds the worker's write lock during the diagnostic. Native `quick_check` can scan database pages; its `(1)` bounds reported errors, not execution time. This check is intentionally not an automatic per-request operation.

Model scans use keyset pages, not offsets or all-mail arrays. Batch size is capped at 256; the row budget is capped at one million. `scannedRows` counts inspected model rows and chunk-metadata rows. A single lookahead metadata row distinguishes exact budget exhaustion from the end of a scan. If further rows remain, `scan-budget-exhausted` sets `scanComplete:false` and `ok:false`; a partial scan cannot claim health. Small constant-size schema/lookup queries and the native SQLite integrity checks are outside this model-row budget.

No BLOB data is selected by the model scan; chunk queries inspect `length(data)`. This is a **shallow structural check**. A same-length logical byte change can pass it, and `contentHashesVerified` deliberately stays false. `MailContentStore.read` verifies the complete byte/hash stream at EOF; streamed publication also verifies persisted bytes before committing its manifest. A full-store hash audit and signed-package/platform qualification remain separate work. Do not interpret `ok:true` as provider completeness, current search-index correctness, successful sending or full mail-content verification.

## Durable migration and recovery rules

1. Obtain the existing encryption key through its established key-custody path and open the existing encrypted database. Do not substitute a new key after an authentication/open failure. A database backup without its matching key is not a usable recovery backup.
2. Before a planned version upgrade, preserve a consistent encrypted database backup through a validated SQLite-aware backup workflow, or stop all writers and close every database connection before taking a filesystem snapshot. Do not assume copying only the main file while a WAL is active is a consistent backup. Preserve the matching key through the approved protected key backup/recovery mechanism; never add it to logs, command arguments or an unprotected adjacent file.
3. Run the explicit migrator. All schema DDL and the version update share one transaction. If an upgrade throws or a process stops before its commit, the previous committed schema/data remain the recovery baseline; reopen and inspect before retrying. The v1-to-v2 migration is additive and preserves legacy references rather than discarding data whose bytes have not yet been validated.
4. A newer schema version is a refusal condition, not a reason to recreate or downgrade a database. Preserve the encrypted database, relevant recovery files and matching key. Use a compatible application version or an independently verified restore procedure. Do not overwrite the newer version field to force an older binary to run.
5. A missing table, failed integrity check, unavailable key, incorrect key, incomplete migration or missing published bytes requires explicit investigation. Never auto-delete/reset the store, silently mark content complete, regenerate the encryption key or replace the database with an empty one. Keep the original evidence and backups intact until a recovery decision is made.
6. Once storage is accessible again, abandoned staging may be inspected and explicitly discarded through `MailContentStore` with writers quiesced. Published content is not garbage-collected by that API; shared messages, drafts and future matter references must remain protected.

These rules describe safe recovery boundaries, not an implemented backup/restore UI or an operating-system power-loss guarantee. Worker startup wiring, retry policy and operator-facing recovery actions remain the lead's integration decision.

## Validation

```sh
bun test apps/server/src/mail/storage/consistency.test.ts
pnpm --dir apps/server typecheck
```

The Bun launcher compiles production TypeScript into a temporary directory and runs nine tests in actual Node with the encrypted native database. Cases cover v2 reopen, v1 reopen/upgrade, transactional migration failure, newer-version refusal, missing tables, legacy stored refs without publications, invalid canonical/provider state, disabled/broken foreign keys, missing chunks/publications, fixed-code privacy, bounded keyset scans and the explicit limit of shallow hash checking. Test databases and build output are temporary. No production data or credentials are used.
