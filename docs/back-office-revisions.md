# Back Office revision protection

## Scope

This feature protects the Back Office database: clients, matters, people, companies, billing foundation records, custom objects, fields, relationships, saved views, attachments, queued edits, imports, archive/restore and Back Office permission changes. It does not make the rest of LegalWork revision protected. Projects are referenced by Back Office relationships; their documents, chats, tasks, calendar and other project contents are not audited by this feature.

The desktop database is physically shared with other app stores. Only the `bo_*` tables participate in this journal. Account and firm-policy hooks clean up Back Office caches; a failed Back Office integrity check does not prevent ordinary account changes, policy refresh or unrelated database writes. There is no whole-app recovery export, credential export or app-wide audit subsystem.

## Writes and verification

Business writes and their before/after history commit in the same SQLite or PostgreSQL transaction. Database capture guards cover records, models, views, proposal receipts and file manifests. A failed history append rolls the business change back. Accepted revisions cannot be updated or deleted through application database roles. Corrections append a new revision. Automatic model/template upgrades are recorded.

Each event binds its author and identity source, device/agent identity, action, event UUID, directory, target, schema revision and time to an ordered Ed25519 proof chain. Local attribution identifies the operating-system user/device or cached account; it is not presented as fresh platform authentication. Shared writes use the platform's authenticated caller and recheck firm permissions under the journal lock.

Protocol v2 uses private random payload and state nonces. Public proofs and redacted exports cannot be used to guess hidden low-entropy values such as rates. The state nonce cache is encrypted and checked against the current business projection. Event IDs, scope hashes, structural row identities, guard definitions, keys and retained checkpoints are verified. Missing or changed evidence blocks Back Office operations without automatically resetting or repairing it.

Existing records and legacy audit rows receive a dated baseline. Verification begins at that baseline; earlier events are not retrospectively represented as verified.

## Local durability and its limits

Local Back Office revisions require neither team sync nor a platform connection. The device identity, content keys and durable signed heads live in `back-office-audit`, separately from the mutable database. A coordinator serializes SQLite commit and checkpoint persistence across processes. A first-stream genesis checkpoint is durable before the first business commit. Restart verifies a committed extension before advancing its retained head. A pre-commit crash preserves its orphaned evidence and fails closed rather than resetting it.

These checks detect an older database restored against a newer retained head. A person controlling the whole computer can replace the database, keys and all local checkpoints together. This release does not claim independent proof against that action or legal certification. Keep signed exports or trusted heads in independently controlled retention storage when evidence beyond the device is required. Export verification accepts independently obtained trusted heads and distinguishes anchored coverage from self-consistency. No automated witness service or production retention storage is provisioned by this feature. The UI reports that independent acknowledgement is absent.

A broken history remains blocked for inspection and restoration from a verified backup. Existing signed exports can still be verified through the standalone verification endpoint without opening the damaged Back Office store. No automatic repair, evidence deletion or whole-app restore is performed.

## Permissions and synchronization

History and exports apply both historical and current permissions, including financial/private fields, related matters and project visibility. Model administration alone does not grant financial access. Original payloads are disclosed only when the complete original is authorized; filtered displays never masquerade as original signed payloads. Stable event cursors support pagination. Shared history always checks current platform permissions and never falls back to stale device history when the platform is old, unavailable or denies access.

Known account changes, sign-out and firm-policy reductions clear inaccessible managed Back Office contents, retire their readable history keys and retain opaque proofs. Cleanup also runs after restart. Account-bound replica generations fence late responses, including reconnecting the same account. Older snapshot cursors cannot replace newer cached state. Binding a different platform resets that platform's cursor.

Queued proposals retain only authored deltas and belong to their originating platform, firm and account. Another principal cannot acknowledge, review, discard or upload them. After disconnection, remaining plain authored fields are held for review; copied privileged, file and relation data is removed. Older unattributed proposals are preserved and excluded from automatic sync rather than assigned to a new user. They require administrator investigation and manual re-entry of authorized changes, not automatic ownership adoption.

An offline computer cannot learn a new server-side revocation until it reconnects. Independently saved files and exported copies cannot be recalled.

## Attachments

The native `bo_files` manifest is internal and audited. Preparing a version records its identity and key commitment; committing it follows durable encrypted byte storage and content verification. A local record cannot reference an uncommitted or different version. Each cached copy has a separate file key and authenticated encryption binding the exact scope and metadata. File keys are kept outside SQLite. Changed bytes or replaced/missing keys fail verification.

Removing or replacing a file reference does not overwrite the previous version. The record History tab can download the exact version associated with its signed event. Historical and current permissions are checked before downloading it. Shared historical downloads are authorized by the platform rather than an old cache. File IDs alone do not grant access.

Permission reductions remove inaccessible file manifests and erase their file keys only after the corresponding database commit and durable history checkpoint. Restart resumes key cleanup. Remaining authorized cached versions and separately scoped local originals survive. Legacy Back Office copies with retained readable references migrate to encrypted storage before the old plaintext cache is removed. Full DMS workflows and invoice issuance remain separate features.

## Timesheets and issued invoices

The desktop adds the `bo_timesheets` table to the existing Back Office journal in migration 5. A submitted line references its exact revision. Reviewing, approving, returning, issuing an invoice and approving a correction are recorded as separate actions. The same transaction writes the accounting change and its history. An issued invoice preserves its original document and template. A later correction has a separate decision and, after issuance, its own numbered adjustment note.

Private workday evidence and unaccepted drafts are held in the local user profile. An accepted draft links to its private original by a salted digest. The local author can compare the versions when the original is available on that device. A connected firm requires the platform timesheet endpoint and authenticated reviewer access.

## Twenty comparison and licensing

Inspected upstream commit `19a618dfe629c4a9ed5a0682ff7dd548567d7fbf` (7 November 2026). Twenty's [record timeline](https://github.com/twentyhq/twenty/blob/19a618dfe629c4a9ed5a0682ff7dd548567d7fbf/packages/twenty-server/src/modules/timeline/services/timeline-activity.service.ts) records authors and field differences and supports deleting linked activities. Its [event ingestion](https://github.com/twentyhq/twenty/blob/19a618dfe629c4a9ed5a0682ff7dd548567d7fbf/packages/twenty-server/src/engine/core-modules/event-logs/ingest/create-event-log-from-internal-event.ts) retries a transient ClickHouse failure once, then drops affected envelopes on another transient failure. Its [cleanup service](https://github.com/twentyhq/twenty/blob/19a618dfe629c4a9ed5a0682ff7dd548567d7fbf/packages/twenty-server/src/engine/core-modules/event-logs/cleanup/services/event-log-cleanup.service.ts) deletes older logs under retention settings and carries an Enterprise license marker.

Those are product references, not sufficient revision-protection guarantees. No AGPL/Enterprise implementation was copied. The history UI uses the pinned MIT Twenty UI primitives and existing LegalWork styles.

## Validation

Feature validation covers real SQLite and disposable PostgreSQL, two native clients, process termination before/after commit, concurrent processes, checkpoint failures, older database restoration, direct SQL bypass/forgery, projection/key/guard tampering, nonce-guessing privacy, historical permission filtering, account/origin changes, stale replies, file encryption, immutable historical downloads, legacy file migration and local use with sync disabled or an older platform. No standard app/profile was started, stopped or switched for this work. Screenshots remain outside the repositories.

Final commands and results are recorded in the draft PRs. Integration deployments require the platform migrations and explicit persistent audit-key/authority configuration described in the platform Back Office documentation; this is not required for local-only Back Office use.
