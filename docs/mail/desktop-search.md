# Desktop local search — EIG-140

The Mail route opens **Search mail** beside the reader. Results search the encrypted local FTS index, including extracted attachments; they do not query a provider. Search and saved-query text is held in component memory and encrypted mail storage, never localStorage or the URL.

## Query semantics

Literal text is a case-insensitive NFC substring, preserving punctuation and umlauts: `AZ-12/34.5` and `Änderung`. Phrase uses consecutive FTS5 words; keywords combine quoted FTS terms with AND, not a raw query language. All filled fields combine with AND. Structured controls include explicit accounts, sender/recipient address, UTC date range (inclusive start, exclusive end), account folder/label, read state, attachment presence and exact filename. Case identifier is literal text; it does not claim a matter association or matter ACL. Empty account selection means all accessible local accounts and is stated beside the form.

Results show subject, snippet, account and date, with pending/incomplete index counts. An empty result does not claim a fully downloaded mailbox. Arrow Up/Down and Home/End move among result buttons; Enter opens the selected source. Previous/next pages are bounded at 20 rows. Counts and offsets are live while synchronization proceeds; refresh restarts at the newest first page. Active pages refresh at most once every five seconds, with only one refresh outstanding, and abort on edits, foreground requests or unmount. Explicit Cancel and replacement requests fence late responses. Errors remove results; no request implicitly retries a provider.

Matching attachment links open the first section containing query text, at a bounded offset near the occurrence. The link is provenance for a query-text occurrence, not a claim that every filter or keyword matched within that one part. Token phrase navigation also recognizes punctuation between consecutive words. The indexed attachment list remains available for metadata-only queries. Extracted text shows source section/page, OCR versus text, immutable part/ref binding, bounded continuation and Open source message. The accepted reader handles original bytes and attachments. Access is revalidated by the same worker/service fences before every response; periodic result refresh clears inaccessible result pages.

## Encrypted saved searches

`POST /mail/v1/search/saved` is strict JSON, host-token-only and loopback-only:

- `{action:'save',id:<UUID>,expectedRevision:null,name,query}` creates a named query. Replace with the current revision to update it; stale changes return 409.
- `{action:'list',after?:<UUID>,limit?:1..20}` pages the current owner's preferences, bounded below the worker response cap, with no skipped large records.
- `{action:'delete',id,expectedRevision}` removes the owner's saved query with CAS.

The additive `mail_saved_searches` table stores trusted owner ID, UUID, name, monotonic revision and JSON query inside the encrypted database. No credentials, result snapshots or message bytes are copied. Names are at most 120 characters; query JSON at most 8 KiB; at most 100 saved queries per owner. Paging offsets and result limits are rejected in saved queries. Explicit account selections are checked before save; execution always rechecks current account access before results/snippets/counts. Saved preferences remain owner-readable after a selected account is disconnected, but do not grant archive access. Lock/unavailable-vault and worker shutdown use the existing internal storage gates. Restore preserves the table with the database; no browser preference copy needs reconciliation.

## Focused evidence

```
node apps/server/scripts/mail-acceptance.mjs --suite storage/saved-search --concurrency 1
pnpm --dir apps/server exec bun test src/mail/search-desktop.e2e.test.ts
pnpm --dir apps/app exec bun test tests/mail-search.test.ts
pnpm --dir apps/app exec bun test tests/mail-search-render.test.ts
```

The renderer case uses a standalone Electron executable (optional `LEGALWORK_MAIL_TEST_ELECTRON` override), hidden sandboxed window, temporary profile and loopback synthetic HTTP fixture. It is not a whole-app build/test and uses no real mailbox. Encrypted Node tests prove owner/CAS isolation, exact Unicode filters, DB/WAL plaintext-marker absence, reopen and bounded query pagination. Real HTTP→Node-worker acceptance proves durable saved queries and matching extracted sections. Renderer acceptance covers snippets/index state, keyboard and page navigation, source opening, saving without localStorage and cancellation of a delayed old query. These tests do not claim platform qualification or OCR accuracy beyond the extraction feature's documented limits.
