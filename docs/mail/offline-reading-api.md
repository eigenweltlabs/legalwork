# Offline message and content API

EIG-123 exposes the encrypted local archive through the existing host-token-only loopback service. These operations do not contact a provider. Lock and account disconnect deny metadata and bytes; retained remote deletions remain available to explicit archive reads while the account is unlocked.

All endpoints are JSON POST requests under `/mail/v1/accounts/:accountId/messages/`. They reject unknown fields, request-supplied owner identity, query parameters and bodies over 32 KiB. Responses are `no-store` JSON; no HTML is rendered and no attachment or remote URL is opened.

| Endpoint | Body | Result |
| --- | --- | --- |
| `query` | `{limit?, after?, folderId?, threadId?, includeRemoved?}` | Message metadata page and continuation; removed records excluded by default |
| `read` | `{locator}` | Current normalized headers, provider identity, memberships and content status |
| `parts` | `{locator, page?: {limit?, after?}}` | Original, body-envelope and attachment descriptors, names, hashes and availability |
| `content` | `{locator, request: {kind, partId?, referenceId, offset?, limit?}}` | Base64 range, next offset, total bytes and complete-object SHA-256 |

`locator` uses the existing provider identity schema. Message enumeration uses stable provider-key order and SQL keyset pagination; search supplies relevance/date ordering separately. A reference must belong to the requested current message/part. It cannot be used as an account-wide arbitrary blob lookup. Changed references require restarting the download. Metadata/part pages are capped by the private protocol's 64 KiB frame size; an individually oversized item returns 413 rather than skipping a row.

Read content in ranges of at most 24 KiB until `nextOffset` is null, append the decoded bytes in order, and verify their SHA-256 against the descriptor. The worker validates published storage and chunk lengths. A byte range is not a full-object hash attestation. The `body` object is a versioned JSON MIME projection; original MIME and attachment downloads are byte preserving. Future rendering must sanitize/isolate HTML and block remote resources.

The real HTTP → LocalMailService → encrypted Node worker test reads an original and a 100,003-byte attachment across chunk boundaries without provider configuration or requests, verifies their complete hashes, reopens the store, checks owner isolation and disconnected locks, and rejects oversized or incorrectly scoped requests. The private protocol test rejects identity mismatch, injected scope, noncanonical base64 and nonadvancing ranges.
