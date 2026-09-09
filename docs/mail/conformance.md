# Synthetic mail conformance fixtures

EIG-121 provides deterministic **test inputs and fault scheduling**, not a production provider/store contract or a claim of provider qualification. All addresses use `example.invalid`. There are no credentials, real client messages, network calls or extra dependencies.

Run from the repository root:

```sh
bun test apps/server/src/mail/testing
# Default ten-message adversarial set, including an 8 MiB decoded attachment:
bun apps/server/src/mail/testing/generate.ts /tmp/legalwork-mail-fixtures
# 100,000 messages with 1 KiB generated attachments (10% of messages):
bun apps/server/src/mail/testing/generate.ts /tmp/legalwork-mail-100k 100000 1024
```

Use a new destination each time. The CLI exclusively creates files and refuses an existing manifest. It streams one message at a time and writes `manifest.jsonl` one row at a time; neither MIME nor the manifest accumulates in memory. A file is synced before its manifest entry is appended. This is a fixture exporter, not a resumable store: an interrupted export can leave an unlisted/partial file, and the manifest is synced only at completion. Remove the external output and regenerate after interruption. Do not generate load artifacts in the checkout.

`corpus(count, largeAttachmentBytes)` lazily returns descriptors. `fixture(index, largeAttachmentBytes)` reproduces one without scanning earlier messages. `chunks()` can be replayed and yields fresh byte chunks no larger than 40 KiB for generated attachments. The decoded attachment pattern is byte `offset % 251`, encoded as base64 with 76-character lines and CRLF. The default 8 MiB repeats every ten messages: **pass a smaller size for a 100k-message load** unless intentionally testing roughly 80 GiB of decoded attachment content (plus base64 overhead). A 100k descriptor iteration is not a full 100k-message storage/search benchmark.

`consume(message, asyncSink?)` computes original-MIME SHA-256 and bytes incrementally, awaiting each sink write before requesting the next chunk. It propagates errors and returns no successful manifest on a failed sink. Consumers can wire it to their own adapter or storage test drivers without importing a proposed production abstraction. All fixture MIME uses CRLF and fixed timestamps; changing a fixture intentionally requires reviewing and updating the pinned manifest.

## Expected coverage and manifest

The first ten fixtures repeat by index modulo ten with unique source identities. `expected-manifest.json` pins original MIME byte counts and SHA-256 for the default first ten. Manifest rows also carry account namespace, source identity, optional RFC Message-ID, fixture kind and expected memberships. The CLI adds the output filename. Hashes cover every original byte, including malformed input and all attachment encodings; these are **not decoded-part hashes or MIME parser expectations**.

| Index modulo 10 | Expected property |
| --- | --- |
| 0 | Ordinary message; Message-ID shared with 1 and 3 |
| 1 | Distinct source message in the same account with a duplicate Message-ID |
| 2 | No Message-ID header |
| 3 | Same source ID and Message-ID as 0 in a different account namespace |
| 4 | One Gmail-like message identity with three simultaneous memberships (`INBOX`, `Label_Contracts`, `Label_Urgent`) |
| 5 | Mail dated 2001 in `Archive/2001/Mandate/Verträge` |
| 6 | RFC 2047 German subject/display name and UTF-8 German body |
| 7 | Nested multipart/related HTML + inline PNG Content-ID, embedded message/rfc822, and UTF-8 attachment filename |
| 8 | Invalid base64 and missing closing MIME boundary, whose original bytes must survive |
| 9 | Configurable generated attachment, no committed binary blob |

Identity-preservation checks must count `(accountId, sourceId)`, never deduplicate on Message-ID or MIME hash. Gmail-like memberships must not become separate stored content copies. These metadata labels model the relevant semantics; they are not live Gmail IDs or IMAP/Graph protocol responses.

To refresh golden values after an intentional fixture change:

```sh
bun -e 'import {corpus,consume} from "./apps/server/src/mail/testing/corpus.ts"; const rows=[]; for (const message of corpus()) rows.push(await consume(message)); await Bun.write("apps/server/src/mail/testing/expected-manifest.json",JSON.stringify(rows,null,2)+"\n");'
```

## Fault checkpoints

`FaultInjector` accepts `{checkpoint, occurrence, code, retryAfterMs?}` rules. Occurrences are one-based per checkpoint; duplicates are rejected. A hit records an optional observer event before throwing `InjectedFault`; a rule fires once per injector. Reuse the injector across simulated process restarts to avoid re-injecting the same incident. Create a fresh instance to replay the schedule. Counts use constant space, and no event history is retained unless the caller's observer chooses to retain it. The optional retry delay is data only: tests control their own virtual clock.

| Checkpoints | Intended test placement |
| --- | --- |
| `page:before`, `message:before` | Before obtaining a page or starting a message |
| `chunk:before` | Before each content write, to interrupt partial downloads |
| `content:durable` | After the consumer has committed complete content |
| `cursor:before`, `cursor:durable` | Immediately before and after the consumer persists progress |
| `submit:before`, `submit:accepted`, `submit:recorded` | Before sending, after simulated remote acceptance, after local acknowledgement persistence |

Available codes: `restart`, `network-loss`, `throttled`, `disk-full`, `cursor-expired`, `remote-edit`, `uncertain-submission`. They carry test intent, not actual errno/HTTP/provider errors. Test drivers map them into the concrete implementation's errors. An observer can deterministically mutate simulated remote state at a `remote-edit` event before the fault is thrown. Recovery policy belongs to the system under test; the harness does not sleep, retry, advance cursors, write storage, or resubmit automatically.

The tests demonstrate durable-content-before-cursor ordering, replay after interruption without dropping duplicate RFC IDs, disk-full failure before completion, one-shot retries, exact failure order, and acceptance before local recording for uncertain submission. The outbound example deliberately stops in the ambiguous state; it does not demonstrate safe provider reconciliation or exactly-once delivery.

Future adapter/store conformance drivers should feed these same descriptors and compare exported original bytes and memberships with the manifests. They must then assert their own durable state after restart, cursor reset/rescan after expiry, retry delays under a virtual clock, conflict handling after remote edits, and explicit uncertainty/reconciliation instead of blind resubmission. Real IMAP, Gmail, Graph, SMTP, OAuth, platform disk-full/crash semantics, MIME parser extraction, resource budgets and search performance remain separate integration qualification work. No actual-provider pass is implied by this suite.
