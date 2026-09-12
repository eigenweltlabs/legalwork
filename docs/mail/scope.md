# Mail capability and storage contract

Date: 2026-09-09. Decision owner: Legalwork mail project lead. Implements the planning contract in EIG-119; this document states requirements, not shipped support.

## Product and delivery order

Build a local mail client behind the Legalwork server API. First integrate and test a small vertical slice: encrypted durable originals and metadata, repeatable synthetic/EML ingestion, process restart and offline search. Then connect real Gmail and Microsoft test accounts and grow the same implementation into full-history synchronization and sending. This order allows useful implementation while new app registrations are provisioned.

Use one TypeScript service. Provider transport, account/message identity, durable jobs, content storage and read/search APIs have separate interfaces. Background work runs outside Electron's main/UI thread. The engine evaluation ADR records the evidence and open packaging decisions. Do not copy the isolated spike into production or use stock plaintext SQLite when encryption is required.

The first release qualification targets macOS arm64/x64, Windows x64 and Linux x64, matching existing desktop packaging families. Each target remains unqualified until its native runtime, encrypted storage, OAuth and recovery checks run there. Additional architecture builds are not automatically certified by a package definition. This macOS development host does not establish Windows/Linux readiness.

## Accounts, providers and identities

- Gmail/Workspace: Gmail API, Legalwork-owned desktop OAuth registration, explicit gmail.modify consent. Preserve one account-scoped message with multiple label memberships. The old Workspace read/compose grant is not a full-client grant.
- Microsoft 365 and Outlook.com: Graph with delegated access, immutable identifiers where supported, per-folder delta state and folder discovery. Start with a dedicated organizational test tenant; consumer/multitenant account onboarding remains core work before claiming Outlook.com support. Shared/delegated accounts and allowed sender identities are explicit capabilities.
- iCloud, Yahoo, Fastmail and selected generic hosts: IMAP/SMTP with provider-specific authentication and special-folder behavior. Certify named hosts rather than claim universal IMAP compatibility.
- Proton: optional local Bridge qualification and its installation/plan prerequisites.
- Graph in-place archives, on-premises Exchange, protected messages and historical PST sources require a visible separate capability/import decision.

An account has an internally generated stable ID and an explicit owner. Workspace access or a remote worker connection is not mailbox authorization. Provider message identity is scoped to the account. IMAP adds mailbox identity, UIDVALIDITY and UID. Message-ID, subject, MIME digest and thread identity are never unique message keys. Membership changes do not create or erase other copies. Header Message-ID is optional and duplicates must survive.

The model helpers define canonical provider keys and conservative completeness calculation. They do not grant access, persist mail or replace provider conformance tests.

## Complete offline storage

Default onboarding includes all accessible folders/labels and dates, including Spam/Trash where available. Any explicit user exclusion and any provider-inaccessible scope must remain visible. Recent-first download is scheduling, not a date cutoff.

Persist original provider-returned MIME, raw provider metadata/provenance, normalized message metadata, rendered body inputs and all attachment bytes, including inline images and embedded messages. Provider-exported MIME is not necessarily the original SMTP wire representation. A content hash supports integrity verification, not message deduplication.

Track discovery, metadata, raw MIME, body and attachment completion independently. An enumeration cursor may advance only when the discovered work and its recoverable jobs are durably recorded; fully downloaded is a stronger state, requiring all expected bytes durable and no outstanding/failed/unavailable content. Indexing has a separate progress state. A parser failure preserves originals and reports a visible unsupported/extraction failure.

Content must live in durable application data, outside caches and matter directories. Large data is streamed with bounded memory and stored as encrypted content; database, WAL, index, temporary artifacts and backups must be protected consistently. Do not accept a no-op cipher pragma as encryption. An unavailable validated encryption backend keeps the mail store locked/unavailable rather than silently creating plaintext.

## Retention, disconnect and recovery

The ordinary mailbox view mirrors provider membership, flags, moves and deletions. Local application trash actions follow provider behavior and remain undoable where supported. Retained recovery copies and deliberately filed matter records have separate references and lifecycles.

EIG-151 implementation: retain downloaded content indefinitely by default. A configurable per-account age supplies the cutoff for explicit, previewed cleanup of provider-deleted copies; no automatic deletion runs. Settings exposes export, encrypted backup and separate scoped purge. A firm-policy engine is not yet implemented. This is product recovery behavior, not a legal retention guarantee. See `retention-and-recovery.md`. Explicit local purge requires a clear scope and removes only unreferenced content; a matter copy is not silently purged with an account.

Disconnect stops network jobs and removes/revokes usable local credentials where supported while keeping a locked, readable-after-unlock local archive. Account removal offers explicit export/retain versus purge choices and explains remaining matter records and versioned backups. Key destruction and backup retention must be described accurately; file deletion alone is not guaranteed physical erasure on modern storage.

Versioned encrypted backup is separate from sync. Restore into a clean profile without provider access, verify counts and hashes, rebuild search and quarantine restored pending submissions until reconciled. Never replay old queued sends merely because a backup was restored.

## Core workflows and deliberate actions

Core: multi-account inbox and folders/labels; local threads; flags/read state/archive/trash/spam; compose/reply/reply-all/forward with To/CC/BCC, inline content and attachments; local autosaved drafts plus provider drafts where supported; aliases/signatures; visible outbox; local recipient history; keyboard access, notifications, print and export.

Persist queued actions and reconcile partial failures/conflicts. A timeout after a submission may mean accepted delivery into the provider; represent uncertainty and reconcile without blind retry. Acceptance is not delivery. New live tests use dedicated synthetic accounts and controlled recipients; connecting a mailbox is not permission to send arbitrary test messages.

Gmail modify excludes immediate permanent deletion. Core Gmail UI uses Trash and explains that provider permanent deletion is unavailable under this grant; local-retention purge is a different action. Broader Gmail scope is a separate deliberate product decision. Microsoft/IMAP permanent deletion appears only where the provider capability and explicit action support it.

Agent tools use the same service with owner/account/matter authorization checked before returning messages, snippets, counts or attachments. Mail text cannot instruct tools to expand access or send/delete. Existing user authorization applies; the mail feature must not impose redundant confirmations on already authorized actions.

## Search and budgets

Lexical and structured offline retrieval is core: phrase, exact address, date/account/folder/label, flags, attachment presence, file names and matter identifiers. Test German umlauts and punctuated identifiers. Attachment text and OCR run in bounded background jobs; unsupported/encrypted documents remain visibly unindexed. Semantic retrieval and remote AI processing are optional and never prerequisites for local search.

Reference acceptance corpus: 100,000 messages with varied ages/folders, duplicate and missing Message-IDs, multiple account namespaces, German text, malformed MIME, embedded messages and never-opened attachments. Use explicit size distributions; iterating 100k metadata descriptors is not a full-load benchmark.

Provisional budgets to validate and revise with measured evidence:
- Hardware baseline: 16 GiB RAM and local SSD; record exact CPU/OS/runtime for every result.
- Warm lexical/structured query p95 <=300 ms across a published query set; cold first query target <=2 s after service ready.
- Mail worker peak RSS <=512 MiB during the standard backfill corpus, excluding separately budgeted OCR; individual oversized inputs fail visibly rather than bypass limits.
- No synchronous mail job on the UI/main thread; measure foreground responsiveness during backfill.
- Bound provider concurrency and obey Retry-After; pause writes on disk-full, preserve work and resume after capacity is available.
- Measure startup, bytes on disk, database/index amplification, backfill throughput and energy impact; do not invent a download-time or storage-ratio guarantee before measurement.

## Completion and review

Core release requires explicit platform/provider certification, storage and mutation failure tests, clean-profile restore, account/matter isolation review and a private pilot. OAuth verification, external administrator steps and real-account tests remain open until evidence exists.

Follow-on scope stays separate: S/MIME/protected-mail workflows, synchronized contacts/calendar, native JMAP/on-premises Exchange, advanced rules/scheduled sends, semantic retrieval and full multi-device/firm-hosted operation. Move scope only through a recorded plan change.

Every agent change is reviewed in the integration branch and its meaningful tests rerun by the lead. Linear tracks implementation, review and remaining live/packaged evidence honestly; a synthetic test is not a provider-certification pass.
