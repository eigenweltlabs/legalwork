# Back Office revision security

Implementation status: in progress. This document defines the completion criteria, not a claim that the current feature meets them.

## Required guarantees

The history covers records on every built-in and custom object, relationships, file references and immutable file versions, model definitions and template migrations, saved views, archive/restore, access changes, imports, agent actions, synchronization and conflict resolution. A write and its history must commit together; an audit failure must not silently permit an unaudited write. Corrections append new revisions. Existing evidence is not overwritten or merged for presentation.

Every entry records the responsible principal and identity source, device/agent identity, action, target, model revision, previous/new state, event ID and time. Local identity must identify the operating-system user/device or a cached account instead of presenting all users as `local`. Cached account attribution is not represented as a fresh online authentication.

A signed, ordered hash chain detects payload changes, removed/reordered entries and replacement keys. A retained checkpoint detects rollback or truncation. Verification also checks that the current database projection matches recorded state. Integrity failures block further writes and do not automatically reset or repair history. Explicit recovery preserves the damaged evidence.

History must be inspectable and exportable, with historical model definitions sufficient to interpret old field values. Permission checks apply to both old and new values, financial/private fields, related matters and project visibility. Access revocation must not leave readable team-history payloads on a disconnected device. Preserving signed proofs and deleting inaccessible cached content are different operations.

Existing data and legacy audit rows are migrated without losing content or pretending that old entries were independently verified when they were created. A dated baseline establishes where the new guarantee begins. Automatic template upgrades are recorded.

## Local and independent evidence

Normal local use and local history require no team sync or platform connection. History and its current signed checkpoint survive restarts, migrations and database backups. A device key and checkpoint are stored separately from the mutable database. Storage failures and crash recovery must be tested, including the gap between a database commit and checkpoint persistence.

A user with full control of a computer can replace the database, its keys and its local checkpoints together. Software on that same computer cannot claim independent proof against that entire-computer rollback. The UI must distinguish local verification, independent acknowledgement, pending acknowledgement and a broken chain.

Independent acknowledgement is separate from team data synchronization. A witness receives signed hash-chain proofs, not client/matter values, file names or model contents. It pins each stream's key, accepts only consecutive valid extensions, rejects conflicting/older heads and returns a signed acknowledgement. Its accepted checkpoints must be durably protected against mutation/deletion. Offline changes remain locally recorded; independent evidence starts when the witness acknowledges them. Provisioning or locking production retention storage is a separate deployment action and must never be silently performed against an existing bucket.

## Server and sync invariants

Accepted team changes and their audit entries share a database transaction and serialization order. Rejected edits, retries and conflict handling cannot produce duplicate accepted revisions or leave changes without evidence. The server binds attribution to the authenticated caller. Database roles must not update/delete historical entries, and database enforcement must reject direct mutation of protected rows. Backup/export verification and external checkpoints provide evidence beyond ordinary role restrictions.

Audit history cannot be dropped during normal cleanup or because an event sink is unavailable. Sign-out and authorization revocation may erase local cached team contents, but cannot erase the authoritative server history or silently reset the proof stream. Independent checkpoints are not an authorization bypass and do not grant access to records.

## Completion evidence

- Feature tests exercise every mutation path, transaction rollback, rejected edits, actor attribution and historical schema interpretation.
- Adversarial tests modify data, signatures, attribution, keys and projections; remove/reorder entries; truncate history; restore an older database; and attempt SQL updates/deletes with application database roles.
- Restart/crash tests cover checkpoint persistence failures, valid recovery and fail-closed behavior.
- Integration tests use real SQLite and disposable Postgres, exercise two clients and a witness, and prove that local use works with sync disabled or an older platform.
- History and export APIs, agent tools and UI use the same permission filters. Tests explicitly cover historical financial/private-field leakage and revoked records.
- File replacement/removal retains auditable references and does not rewrite earlier bytes. Historical downloads follow retention and current access policy.
- Standard DOCX development checkout remains running. Feature verification must not switch that app without the user's instruction; no native mouse/keyboard automation is used.
- Only relevant feature tests run locally during development. Required type/build/help checks and integration validation run after implementation, with concrete commands/results recorded in both draft PRs.

Twenty's timeline and log-console architecture is a product reference. Enterprise/AGPL source is not copied; LegalWork remains within the requested MIT-only dependency scope.

## Implementation progress

The local foundation now signs ordered audit entries with a device Ed25519 identity, retains content-free state hashes and chain proofs, encrypts historical payloads per stream, and persists separate durable checkpoints. SQLite triggers capture record, model, view and queued-proposal writes in the business transaction. Existing legacy entries move into a dated encrypted baseline, with no retrospective verification claim. SQL updates/deletes of historical entries are blocked. Revocation retires the readable stream and erases its content key while retaining proofs. Record/model history metadata is now read from this journal.

Focused tests cover payload/actor/key tampering, removed/reordered entries, valid chain extensions, older-database restoration, immutable SQL history, business rollback when an audit insert fails, encrypted history, retained proofs after revocation, nested rollback, legacy migration and nested user/agent attribution. These tests establish the local foundation only.

Remaining work before completion:

- Serialize database commit and separate checkpoint persistence across processes. Add restart/crash and failed-checkpoint recovery tests. Prevent stale checkpoint writers from racing.
- Add incremental verification without weakening detection of external database/schema/key changes. Current full verification before each transaction is deliberately conservative and needs a scaling check.
- Verify on the API read boundary and provide integrity status and explicit recovery/export of damaged evidence. Validate required SQL guards instead of silently reinstalling modified protection.
- Give file upload/commit and historical file access their own complete evidence path and retention/access checks.
- Add platform append-only history, migration/verifier coverage, authenticated attribution and atomic accepted-change auditing. Existing platform audit tables are not yet hardened by this work.
- Implement independent signed checkpoint receipts, key pinning, replay/rollback protection and deployment configuration, separately from team sharing. Do not label unanchored local history independently secured.
- Add permission-filtered historical values, historical model interpretation, pagination, verifiable exports, agent tools and the Twenty-style history UI with en/de help.
- Complete two-client/real-database integration and the adversarial permission/lifecycle matrix. Finish required builds/help checks, update both draft PRs and assess CI only after the complete feature is ready.
