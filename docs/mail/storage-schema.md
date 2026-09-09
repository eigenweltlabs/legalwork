# Durable mail schema and repository (EIG-124)

`migrateMailSchema(database)` installs schema version 5 (including the original v1 tables) in one synchronous transaction. It enables and verifies foreign keys, records a singleton version, does nothing on a repeated current migration, and rejects future versions without a downgrade or destructive reset. An unversioned database containing conflicting mail tables also fails instead of replacing data. This is a dedicated mail database, not a migration for the existing general server store.

`MailRepository(database, ownerId)` accepts only the injected `MailDatabase`. It opens no files and supplies no plaintext fallback. The service supplies the authenticated owner scope; callers must not choose it from an untrusted request body. Every existing-account operation checks ownership. Account IDs are globally unique locally, and every subordinate identity/reference uses account-composite keys and foreign keys. The isolated in-memory stock SQLite adapter exists only inside `repository.test.ts`; encrypted factory/worker and packaged-runtime validation are separate work.

## Tables and identities

- Accounts record owner, provider and display name. Folder/label rows support account-local parent references; repository writes reject hierarchy cycles.
- Messages use the existing canonical `providerMessageKey` with a separate account key. RFC Message-ID, MIME hash and thread ID are never uniqueness keys. IMAP mailbox + UIDVALIDITY + UID changes create separate rows; discovering a move/copy does not silently delete the source. Deletion reconciliation remains explicit future work.
- Memberships represent folder/label membership separately from message content. A Gmail message with multiple labels has one message identity and content manifest. IMAP ingestion requires exactly its locator's mailbox membership.
- Threads are distinct account-local rows, referenced by messages. Provider adapters supply thread IDs; this layer does not infer threads from RFC headers.
- Immutable content references record an opaque encrypted-blob reference, bytes and SHA-256. Multiple message manifests may intentionally reference the same account-local content reference. A hash alone does not merge messages or references.
- Content manifests record raw MIME, extracted body and attachment parts separately, with pending/stored/unavailable states. Stored parts require a reference; other states forbid one. Raw/body use an empty part ID; attachments require a stable nonempty part ID.
- Schema v2 adds staged/published blob objects, bounded BLOB chunks and account-local SHA-256 publications; see [streamed content](streamed-content-store.md). The upgrade preserves all v1 data.
- Schema v3 adds sync scopes/jobs, v4 adds encrypted credential records, and v5 adds the bounded [mutation/submission action journal](action-journal.md). Legacy `mail_actions` remains preserved and excluded from execution.
- Cursor, draft, legacy action and tombstone tables reserve durable records. Their lifecycle, retries, sending, conflict policy and provider checkpoint transactions are not implemented by this repository. Tombstones deliberately outlive message rows and therefore reference the account and canonical identity, not a live-message foreign key. No production code writes those reserved tables yet. Schema v10 adds separate immutable local draft revisions, intent pins and metadata event streams; see [local drafts/actions/events](local-drafts-actions-events.md).

## Focused repository API

`createAccount` / `listAccounts`; `putFolder` / `listFolders`; `ingestMessage`; `putContent`; `setAttachmentsEnumerated`; `readMessage`.

`ingestMessage` transactionally upserts metadata and replaces the **complete membership snapshot for that provider identity**. An invalid folder rolls back metadata, thread creation and membership changes together. It preserves existing content and attachment-enumeration state: metadata/label refresh is not itself a content invalidation. A provider content revision must explicitly invalidate/rescan the relevant content and set attachment enumeration false. Draft mutation and revision policy belong to their future adapter lifecycle.

`putContent` requires the content writer to supply a reference only after encrypted content is durably stored and verified. It stores metadata, not content bytes, and cannot attest to filesystem durability or encryption itself. A reused reference ID must retain the same bytes/hash; failed manifest insertion rolls back a newly inserted reference. Unreferenced old blobs are not deleted here; retention/garbage collection needs a separate policy.

`readMessage` reports `downloading` until raw MIME and body are stored, attachment enumeration is explicitly complete, and every discovered attachment is stored. An unavailable part produces `attention`, never completion. This is **per-message known-content completeness**, not account-wide discovery, provider archive accessibility, attachment extraction quality, job completion or searchable-index completeness. An empty attachment list before enumeration cannot mark a message complete. `setAttachmentsEnumerated(true)` is the adapter's explicit assertion that it has discovered every accessible part; the repository cannot infer missing provider parts.

All data values use parameterized SQL; SQL access is internal to the trusted storage worker. No route, credential, network, search engine, sending or job behavior is introduced.

## Validation

```sh
bun test apps/server/src/mail/storage/repository.test.ts
pnpm --dir apps/server typecheck
```

Tests cover atomic/idempotent migrations and failure retry, newer-version rejection, duplicate RFC IDs/hash preservation, shared Gmail-label content, owner isolation and account-composite foreign keys, nested-folder cycles, IMAP resets/moves/copies, rollback on invalid memberships, conservative content states, reference immutability and SQL-shaped/maximal opaque identifiers. These stock SQLite schema tests do not establish encrypted storage or crash/power-loss durability.
