# IMAP account discovery and full-history backfill (EIG-133)

The existing local host API now supports password/app-password IMAP accounts through a real ImapFlow transport. This is full-history synchronization of configured folders, including originals and MIME-derived attachments. IMAP incremental changes, mutation/SMTP execution and provider-specific onboarding/certification remain EIG-134/EIG-135. No live mailbox was used for this implementation.

## Local API and custody

Unlock the local store first using `POST /mail/v1/unlock`. Submit JSON to `POST /mail/v1/imap/connections` with `host`, optional `port` (993 by default), `username`, `password`, optional exact discovered `folders` paths, and optional `reconnectAccountId`. Only a valid host token on the explicitly enabled loopback service can call this route. The request body is bounded at 60 KiB; credentials never enter a URL, executable argument, environment variable, diagnostic or response. Implicit TLS and system trust verification are mandatory. There is no plaintext, STARTTLS downgrade, proxy or certificate-bypass field. Servers requiring OAuth-only IMAP cannot use this password flow.

Success returns `{accountId, provider:"imap"}` after authentication and discovery. Failure returns `{error}` with a fixed code, including `authentication_failed`, `certificate_failed`, `reconnect_required`, `stale_credentials`, `timeout` or `unavailable`; provider response text is never reflected. A failed connection publishes no account or password. Configured identity is the owner/host/port/exact-username tuple, not an assertion of a globally verified human identity. Reconnecting requires the same tuple and compares the captured credential generation/revision. Successful password/configuration replacement starts a fresh durable backfill generation while preserving originals and prior jobs; it cannot accidentally complete an interrupted folder list.

Password-free discovery is available at `GET /mail/v1/accounts/:id/imap?after=...`: configuration, advertised capabilities and at most 50 folder records with path, delimiter, special use, selectability and configured selection. Responses are byte-bounded and provide `nextCursor`; no folder ID is truncated. `INBOX`/LIST special-use metadata is retained for the separately owned Inbox role migration.

Use the existing `POST /mail/v1/accounts/:id/sync/start`, `/sync/pause`, and `GET /mail/v1/accounts/:id/sync`. Start launches background work and returns immediately; pause and process close cancel the connection and fence late publication. Paused runs resume their durable UID cursor. Starting an already completed run performs another full scan. Progress includes configured folder/exclusion counts, discovered/downloaded/projected messages, pending/failed jobs and a fixed error. A completed result requires published encrypted content, not merely successful enumeration. `retained` counts original-bearing identities from older UIDVALIDITY epochs.

The normal account/message/part/content/search APIs expose offline originals and attachments. Disconnect clears the IMAP password, changes the credential generation and locks account reads/search. The password lives only in the keyed encrypted mail database, protected by the existing OS-vault wrapping key and private directory controls; this module refuses an unkeyed database. Backup restore clears IMAP passwords and pauses runs, retaining original bytes, attachment pins, drafts/actions and search data. An explicit reconnection is required before account access resumes.

## Identity and resource contract

Schema v12 adds separate IMAP credential, run, folder and INTERNALDATE tables. A message identity is the account plus `["imap", mailboxPath, UIDVALIDITY, UID]`; identical RFC IDs or bytes in different folders/epochs remain separate records. Bodies may deduplicate encrypted bytes without collapsing these records. INTERNALDATE is stored as milliseconds in `mail_imap_messages.internal_date`; `\Seen` supplies canonical unread state. Folder UIDVALIDITY is checked on enumeration and again before raw reads. A changed epoch stops the current run with `uidvalidity_changed`; explicit restart captures a new generation without deleting old originals. UIDNEXT at folder opening bounds that folder's full scan; later arrivals belong to a subsequent scan/incremental feature.

One account session and one read-only TLS connection are active per engine. EXAMINE/read-only mailbox selection and UID FETCH/BODY.PEEK do not mark messages read. Enumeration requests minimal UID/flags/INTERNALDATE and commits jobs plus cursor atomically. Pages contain at most 1,000 messages, matching the existing journal cap. ESEARCH MIN skips gaps when advertised. Older servers use adaptive UID spans: empty spans widen, dense spans close and retry a narrower range without advancing the durable cursor. A mailbox with at most 1,000 messages can safely enumerate the whole remaining UID range. Sparse UIDs 1 and 4,000,000,000 therefore do not require millions of requests.

Limits: 1,000 discovered folders, 100 configured paths, 512 characters per path, 256 advertised capabilities, 16 KiB protocol lines, 64 KiB literals, 128 KiB assembled responses, a monitored 2 MiB discovery/metadata operation budget, 20-second metadata deadlines, 10-second connection/greeting deadlines, 15-second socket inactivity deadline, and 120-second/64 MiB originals. Raw partial reads and content writes use 64 KiB chunks. No `SEARCH ALL` result or whole original is collected in memory. Compression, IDLE, raw logging and library logging are disabled. Bounded job/discovery retries persist their delay; certificate/authentication failures and changed UIDVALIDITY require attention. Over-limit or unavailable content remains incomplete rather than disappearing from progress.

## Focused validation

- `node apps/server/scripts/mail-acceptance.mjs --suite providers/imap-backfill`: actual encrypted Node, actual loopback TLS IMAP fixtures, UID copies/pages, sparse fallback, password replacement after interruption, certificate/authentication denial, restore quarantine, real service/worker and offline attachment reads.
- `pnpm --dir apps/server exec bun test src/mail/imap-http.test.js`: actual host HTTP → service → Node worker → TLS IMAP → encrypted content, including host-token denial, certificate-bypass-field rejection and disconnected read denial.

The fixture CA/private key under `testing/imap/` is synthetic test data only. Production never loads it or changes system trust. Tests use portable Node APIs and the existing native cipher runtime; platform-wide builds/qualification are intentionally deferred to final integration.

ImapFlow **1.7.8** is pinned in server and desktop. Version 2.0.0 was too new under the repository's minimum-release-age policy. ImapFlow and its shipped dependency license notices remain in the installed distribution; ImapFlow is MIT. No dependency-age policy was bypassed.

Primary sources checked 2026-09-09:

- [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/): TLS settings, read-only selection, capabilities, UID fetch and streamed download.
- [Fetching messages](https://imapflow.com/docs/guides/fetching-messages/): async FETCH consumption and download chunking.
- [Mailbox management](https://imapflow.com/docs/guides/mailbox-management/): hierarchy and mailbox locks.
- [IMAP4rev2](https://www.rfc-editor.org/rfc/rfc9051.html): UID/UIDVALIDITY identity, UIDNEXT bounds, read-only selection and partial BODY.PEEK.
- [ESEARCH](https://www.rfc-editor.org/rfc/rfc4731.html): MIN return option.
- [ImapFlow source](https://github.com/postalsys/imapflow): pinned package types/source additionally verified for literal/response limits and streamed FETCH backpressure.

https://linear.app/eigenweltlabs/issue/EIG-133
