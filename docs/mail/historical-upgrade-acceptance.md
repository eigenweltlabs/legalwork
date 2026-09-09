# Historical upgrade acceptance (EIG-152)

Run the existing actual Node/native harness from repository root:

```sh
node apps/server/scripts/mail-acceptance.mjs --suite storage/historical-upgrades --concurrency 1
```

Four cases passed on macOS arm64, Node 24.11.0 with the pinned encrypted SQLite binding. Each starts with a populated, closed encrypted store created from actual historical v5 or v9 migration SQL. Fixture provenance and regeneration live in `src/mail/testing/historical-schema/README.md`.

A separate Node process opens that store, synchronously writes a fixed boundary marker, and kills itself with SIGKILL inside the current migration transaction either after v10 DDL or immediately after writing the new schema version. No orderly process exit, database close or explicit rollback executes. The child inherits no environment except SystemRoot/WINDIR on Windows; acceptance checks the exact marker and platform termination result. Historical setup enables and verifies foreign keys before starting its transaction. Reopening must recover the exact prior schema/version and unchanged original/attachment hashes, legacy draft content reference/revision, memberships, completeness, and all queued/uncertain action fields. Retrying upgrades to the current schema; a further close/reopen/migrate remains idempotent. Only the queued action can subsequently be claimed; uncertain and legacy actions remain unreplayed. DB/WAL scans exclude the synthetic private-content marker and foreign keys remain valid.

Existing `storage/maintenance.node-test.mjs` already covers real v10 restore with immutable draft revisions, attachment pins, quarantined queued submissions and reset event cursors. This slice adds historical upgrade coverage rather than duplicating that recovery case. No implementation regression was found; no production schema or migration change was required.

This is process-interruption recovery on the tested native runtime. It does not claim power-loss/filesystem fault certification, signed packaging, Windows ACL qualification, or provider sending.
