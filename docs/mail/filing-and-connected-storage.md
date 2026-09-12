# Retained mail, connected storage and matter filing

EIG-148 adds **Save to connected storage** in the shared mail viewer. Choose a workspace, a writable connection and a folder, then save the original `.eml`, attachments (including inline images), or both. Each save includes a provenance JSON file. The original MIME and decoded attachment bytes are verified and pinned in encrypted local storage before remote work begins. Retained files can be downloaded and verified again after the provider source disappears.

## Connected storage dependency

Mail uses the shared `StorageRoot` contract and existing `POST /workspace/:id/storage/:storageId/content?path=...` route. It does not contain provider adapters or provider credentials. Every writable root is eligible, including team roots and the OAuth storage integrations. Read-only roots are disabled. These reviewed interfaces are on separate, unmerged dependencies:

- [Shared file storage, PR 131](https://github.com/eigenweltlabs/legalwork/pull/131), contract tested against `5a86fd8f6`.
- [Dropbox, PR 137](https://github.com/eigenweltlabs/legalwork/pull/137).
- [Google Drive, PR 138](https://github.com/eigenweltlabs/legalwork/pull/138).
- [OneDrive and SharePoint, PR 139](https://github.com/eigenweltlabs/legalwork/pull/139).

Until the shared storage route is integrated, the picker reports that File storage configuration is unavailable. Synthetic contract tests cover all root kinds; the composed WebDAV fixture exercises the actual shared route, authorization, staging and verification. This is not real-provider certification for the unmerged integrations.

The host-only mail route checks the configured workspace before using a fixed loopback origin and the server-owned client bearer. The shared route independently enforces collaborator authorization and current writable-root permissions. No endpoint, token or storage credential comes from the renderer. The shared route stages and verifies the complete incoming stream, performs create-only publication, and returns its verified version. Mail streams pinned bytes in 24 KiB chunks and verifies their SHA-256 and size. Current limits are 101 retained parts, 64 MiB per part, 96 MiB total and 48 KiB of serialized provenance.

Root revisions are checked before and after each upload. The shared route captures the root before staging and has no expected-revision CAS parameter, so these checks are **best effort**, not an atomic configuration fence. A changed connection stops subsequent files. Accepted versions remain evidence of earlier writes.

## Cancellation, uncertainty and recovery

Each save has a durable local intent and generated unique filenames. Repeating an ordinary save reuses its intent; create-only writes never overwrite an existing filename. Verified per-file versions survive interruption. A lost acknowledgement, failed verification or ambiguous provider outcome is shown as requiring destination review. The UI offers **Save new copy to this folder**, which explicitly creates another intent and retained snapshot with new filenames. Earlier files may already exist; users should inspect them first. This is manual recovery, not a claim that an existing remote file was reconciled.

**Stop upload** aborts the shared request and prevents remaining files from starting. Already verified files retain their versions. An in-flight file becomes uncertain because cancellation cannot undo a provider write already accepted. There is no remote rollback or delete promise. Mail lock and server shutdown synchronously abort active work, including pending root lookups; shutdown waits for those requests to settle. The post-preflight epoch fence prevents a late create response from starting a job after shutdown. No reconnect or relaunch automatically retries remote saves.

If custody closes or account access is revoked before an acknowledgement can be recorded, the last durable uploading state is retained and converted to uncertain on worker recovery. A reconnect changes the generation and prevents replay of that old intent. Even a known response may then lack a locally recorded version; users must review the remote destination before explicitly saving a new copy.

Backup restore quarantines every old save, including completed receipts. Queued/uploading jobs and parts become uncertain; accepted versions and all retained pins remain intact. Old quarantined intents cannot resume. An explicit fresh copy can use the same currently authorized folder and retains the original bytes even if the provider source no longer exists. Backup validation checks receipt-to-manifest size/hash/type links and accepted-version consistency without changing the version-1 inventory digest. External storage copies are outside the local mail backup and are not deleted by mirror retention. Retained snapshots block full account removal under EIG-151.

## Separate matter association

**File in a LegalMemory matter…** is an optional, separate operation. Generic storage versions and imported provenance never grant matter access or imply ingestion. The authenticated filing backend is [LegalMemory draft PR 23](https://github.com/eigenweltlabs/LegalMemory/pull/23), unmerged and undeployed. Its tools resolve the transport identity, enforce explicit project denies before allows, distinguish filing-write from receipt-read permission, verify upload hashes, and atomically bind receipts, document versions, source objects and matter-pinned ingestion intents. Abandoned staging is bounded and expires. Backend content deduplication does not expose cross-matter hash existence.

Local snapshots preserve the original account, locator, received time, MIME metadata and hashes. One snapshot can have independently authorized receipts for multiple matters; deleting a provider source does not erase retained evidence. Filing retries reuse the durable replay key after fresh write authorization, so a lost commit response does not create another filing. Remote retention follows the destination's policy; local mirror cleanup does not claim to delete backend documents or receipts.

Matter-filtered search first gathers all matching local receipts, checks fresh backend read authorization in batches of at most 200 IDs, and only then executes the local query. The aggregation retains compact identifiers and hashes rather than document-part payloads. Its explicit processing limits are 50,000 candidates or 16 MiB of compact scope data, not a silent first-page result. Above that budget it returns unavailable and asks for narrower account selection. Four worker scopes at most, a 120-second lifetime, exact owner/workspace/accounts/backend/generation binding, and one-shot consumption bound the transient state. Cancellation, errors and shutdown discard it; it is not a persistent authorization cache.

Authorization also binds the **exact source content version**. A local-only digest in the retained original part covers raw reference/hash, projection metadata, body reference/hash, attachment metadata/reference/hashes, subject and received time. A changed message under the same provider ID cannot inherit an older receipt's authority. Legacy snapshots without this digest fail closed for current-source access. The worker validates current versions synchronously before counts, snippets and pending/incomplete statistics. Retained original downloads through the trusted host remain separate from current-message matter access.

For EIG-149, `MailFilingCoordinator.authorizeSource(workspaceId, accountId, locator, matterId, resolveBinding)` returns a source-version fence after current receipt authorization. `assertSourceVersion(accountId, locator, expected)` must be checked after awaited reads/chunks/source assembly and before exposing the result. The injected binding closure must be host/grant-bound; caller-provided workspace strings, receipt lists or general read tokens are not filing authority. Backend permission changes across separate RPCs remain a normal non-atomic preflight boundary; configured binding changes fail closed before query execution and after the result returns.

## Focused evidence

From this worktree:

```sh
pnpm --dir apps/server exec bun test src/mail/storage/storage-save.test.ts
pnpm --dir apps/server exec bun test src/mail/storage/filing-store.test.ts src/mail/storage/storage-save-schema.test.ts
pnpm --dir apps/app exec bun test tests/mail-storage-save-render.test.ts
pnpm --dir apps/server exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types bun-types,node src/server.ts src/mail/runtime/worker.ts
LEGALWORK_STORAGE_CONTRACT_SOURCE=/path/to/legalwork-file-storage pnpm --dir apps/server exec bun src/mail/testing/storage-save-contract.mjs
```

The native fixture exercises encrypted storage, exact MIME/attachments, all writable root kinds, duplicate/no-overwrite behavior, lost acknowledgements, cancellation after remote staging, shutdown and lock, fresh same-folder restore recovery, receipt integrity, 501-receipt paging, revoked read scope, V1/V2 denial and replay-safe matter uploads. The renderer fixture covers writable roots, selected folder/files, stale workspace/folder/message callbacks, stale folder pagination, Stop upload and explicit new-copy recovery. All data and profiles are synthetic; no live accounts, real provider uploads or normal desktop sessions are used.
