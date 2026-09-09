# Local lexical and structured mail search — EIG-137

`POST /mail/v1/search` and `POST /mail/v1/search/rebuild` run through the local host-token API, owner-bound service and Node/Electron encrypted worker. Both require JSON and reject unknown keys, remote bearer authorization, non-loopback hosting and locked storage. No SQL, paths, provider URLs or owner override are accepted. Disconnected accounts cannot contribute results, snippets, counts or rebuild access. A mixed explicit account selection containing a foreign or locked account fails entirely.

Example search body:

```json
{
  "accountIds": ["local-account-id"],
  "keywords": ["Verträge"],
  "phrase": "fristlose Kündigung",
  "sender": "partner@example.test",
  "recipient": "associate@example.test",
  "afterDate": "2026-01-01T00:00:00.000Z",
  "beforeDate": "2027-01-01T00:00:00.000Z",
  "folderId": "INBOX",
  "unread": true,
  "hasAttachment": true,
  "filename": "Prüfung-12.3.pdf",
  "matterIdentifier": "AZ-12/34.5",
  "limit": 20
}
```

All filters combine with AND; `accountIds` combines accounts with OR. Omitted account selection means all currently unlocked accounts owned by the bound user. Omitted textual filters permit structured-only listing. `keywords` is an array of quoted literal FTS expressions combined with AND; each string may itself contain a phrase. `phrase` requires adjacent Unicode word tokens. SQL/FTS operators supplied by callers are ordinary quoted text. FTS `unicode61 remove_diacritics 0` preserves umlauts: `Grüße` is case-insensitive but does not mean `Grusse`. Input and indexed text normalize to NFC. Token punctuation is a boundary, so use `literal` or `matterIdentifier` for a case-insensitive substring preserving exact punctuation, such as `AZ-12/34.5`.

Sender and recipient match complete parsed mailboxes, case-insensitively, including recipient To/CC/BCC. Display names never grant address matches. Groups, comments and quoted display names are handled; malformed/obsolete mailbox syntax may remain unmatched. Filename matches the entire case-insensitive NFC filename, including punctuation and extension; unnamed attachments still match `hasAttachment:true`. Unknown attachment state is `null` and matches neither boolean filter. Date lower bound is inclusive and upper bound exclusive: Gmail uses persisted provider received/internal time; other providers currently use valid MIME Date. Gmail unread uses the current UNREAD membership; other providers use nullable canonical `is_read` (unknown matches neither state). Folder/label and read-state filters consult current canonical rows, rather than a stale index snapshot.

Results contain locator, account, subject, a plain-text snippet, date and attachment state. They return `total`, `pending`, `incomplete` and `nextOffset`. Counts apply only to the authorized account set. Ordering is descending date, then account/message identity; offset pagination is bounded to 10,000 and is not a snapshot across intervening sync changes. Up to 25 results and 48 KiB of response payload are returned; snippets/subjects are at most 512 characters. The UI must treat snippets as text, never HTML. Search includes locally retained remote-removed originals; applying a current folder filter excludes records without that membership.

## Offline rebuild and freshness

Call `/search/rebuild` with `{"accountId":"local-account-id","reset":true,"limit":10}` once to start a full account rebuild, then repeat without `reset` until `pending` is zero. Calling with `reset:true` on every batch deliberately restarts that account. Both automatic indexing and the explicit bounded operation read encrypted local MIME projections/body bytes, never fetch providers. Newly ingested/changed content is queued automatically by transaction-local dirty triggers. Dirty records are excluded immediately from both hits and counts until indexed. Query `pending` is therefore essential coverage information; a zero-hit response with pending work does not establish absence. The ready worker automatically processes one dirty message per event-loop turn, rotating accounts fairly. It idles between checks, skips disconnected/foreign accounts and cancels its timer before shutdown. New synchronized mail therefore becomes searchable without manual API calls. Explicit rebuild remains available for recovery.

Schema v8 stores FTS5 external-content documents and its shadow tables in the same validated encrypted database/WAL. It adds nullable `mail_messages.is_read` for generic provider flags. Each rebuild processes at most 25 messages (default 10); projected body JSON is capped at 2 MiB per message. HTML extraction scans forward once; unmatched repeated script/style tags cannot repeatedly scan the suffix. Invalid out-of-range received dates become null/incomplete rather than poisoning the batch. Oversized bodies, unavailable/corrupt projections and filenames longer than 512 characters remain visibly `incomplete`; original bytes are preserved. Plain text and HTML text inputs are indexed; HTML scripts/styles are removed, tags discarded and entities decoded using pinned `entities@6.0.1` (BSD-2-Clause). Attachment *filenames* are indexed; attachment document text/OCR is outside this ticket. No stemming, semantic ranking or external search service is introduced.

Actual LegalMemory matters live behind remote `list_matters`/`list_matter_documents` authorization in `legalmemory-fetch.ts`; the local mail store has no deliberate filing association or matter ACL. Per the delivery decision, association-based matter filtering belongs to EIG-148. `matterId` is rejected, and `matterIdentifier` is explicitly text search, never proof of membership or permission.

## Evidence and limits

Synthetic actual encrypted Node cases exercise keyword/phrase and exact address/file/German/punctuation behavior, date/folder/unread filters, unnamed attachments, HTML entities, scope/disconnect, encrypted DB/WAL markers, pagination, stale raw invalidation, bounded offline rebuild and atomic v7 migration rollback. An actual HTTP→service→Node-worker test exercises search, authorization, lock/reopen and rebuild. The Electron ASAR fixture loads the built worker plus entities and executes local search; it checks the actual unpacked native cipher binding and reopen.

This is functional acceptance on the macOS host, not the 100k-message performance qualification, Windows/Linux certification or complete encrypted recovery qualification (EIG-126 remains open). SQLite semantics: [FTS5 primary documentation](https://www.sqlite.org/fts5.html). Dependency license is recorded in the pinned installed package and [upstream entities](https://github.com/fb55/entities).
