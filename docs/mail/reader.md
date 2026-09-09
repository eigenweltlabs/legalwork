# Local mail reader — EIG-139

The sidebar's Mail entry opens `/mail`: an Inbox across accounts, All mail, account folders/labels, newest-received pagination, account-scoped threads and an offline reader. Gmail Inbox is the provider's `INBOX` label; Graph resolves the well-known `inbox` identity under credential/run fences. Display names never determine Inbox membership. IMAP integration uses canonical INBOX / LIST special-use and FETCH INTERNALDATE.

The existing desktop runtime connection supplies the local host token. The reader accepts only explicitly spelled `http://127.0.0.1:port` or `http://[::1]:port` endpoints, refuses redirects, and never accepts mailbox wrapping keys. Stored-settings fallback is similarly limited to literal loopback. Lock/account switches abort reads and discard displayed messages, bodies, inline resources and previews. Access/current-original changes are checked while reading; sync progress updates while an account is selected.

`order: received` is additive to the existing message-list contract. It uses IMAP INTERNALDATE, Gmail internal receipt time and Graph receivedDateTime, then the immutable message key. Unknown dates sort last, without substituting sender-controlled Date headers. Per-account keysets are merged only after each account has a current head, with account ID/key tie-breaks. One visible 25-message page replaces the previous page; Next reaches the entire mailbox without accumulating all mail. Newest page starts over. Concurrent mailbox changes may require Refresh. Sorting receipt metadata currently scans the selected account; this is not the deferred 100k-message performance qualification.

Bodies use DOMPurify's explicit allowlist and an opaque sandboxed iframe with scripts disabled and CSP `default-src 'none'`. Sender links, forms, CSS, SVG, embedded documents and external images are removed. Only hash-verified stored PNG/JPEG/GIF/WebP inline parts can become image data URLs. Bodies and inline images have separate bounded reader limits. Partial, unsupported and inaccessible content is visibly distinguished from complete offline copies.

Open uses the existing shared right-hand file pane with ephemeral, verified sources; PDF, raster images, text and original EML are supported, and DOCX has an explicitly labelled read-only text projection. Unsupported formats require explicit Save. See [attachment-preview.md](attachment-preview.md) for limits and source retirement.

Save uses a dedicated trusted-main-frame handler. It re-reads the selected stored reference and authoritative filename through the host-authenticated API, streams at most 24 KiB per request to a generated private temporary file, verifies size/hash, and rechecks current access before publication. Only a native save dialog supplies a destination. Print produces a plain-text print view of the current readable message; Export original preserves the stored RFC822 bytes. No provider fetch is needed to open a previously unopened stored attachment.

Focused acceptance: browser-client malicious-origin and k-way pagination tests; real encrypted service→worker oversized receipt-page continuation/migration/owner tests; Graph well-known Inbox and disconnect-fence tests; native artifact corruption/cancellation tests; isolated actual Electron renderer with hostile HTML, no external requests, opaque frame/script denial, offline CID extraction and lock purge. Renderer fixtures use synthetic HTTP data; encrypted worker behavior is checked separately. No whole-app build, broad test suite, platform matrix, live mailbox or user profile is part of this ticket's verification. Search is integrated into the same message list under EIG-140; composing remains a separate ticket.

Integration: the small `reader-schema.ts` migration is version 13 after the accepted IMAP migration. Synthetic downgrade fixtures remove the role column/index/trigger before replaying old migrations; production migration remains atomic and refuses future versions.

Mail opens automatically with the OS keychain on entry. There is no manual lock/unlock control. An unavailable vault or service produces a retryable error; internal shutdown and maintenance still clear readable content.

## Development preview profiles

`LEGALWORK_ELECTRON_USERDATA` selects an isolated desktop profile. In development, OpenCode's database follows that profile under `legalwork-dev-data/xdg/data/opencode/opencode.db`; using a fresh preview profile therefore shows different tasks. It does not migrate or erase the regular development database. The September 9 mail preview uses `output/mail-preview/profile`, while the regular development app retains its existing Application Support profile. A read-only inspection confirmed the original sessions were still present.

Preserving Electron's real OS home for keychain access does not change this development XDG selection: the managed child receives its isolated home explicitly. Production continues using the configured managed OpenCode database path. Do not reset the keychain or move session databases to resolve a preview-profile difference.

## Shared desktop interface

Mail sits above Workflows in the existing application sidebar. Compact icon actions and dense message rows use LegalWork styling. Account folders nest below their account. One toolbar search replaces the middle message list with results while preserving the reader; filters and saved searches expand within that list. Provider connections open the global Mail Accounts page in Settings and return to Mail.
