# Portable mail archives — EIG-150

Settings → Mail accounts → Import and export mail creates a separate offline archive. Choose a directory of `.eml` files (recursively), an **mboxrd** file, or a LegalWork portable archive directory. Select the resulting **Local archive** in Mail to read all imported messages and search their projected bodies and supported attachments. Import has no provider connection, credentials, mutation journal or upload path. New mail can still be composed from a connected online account; reply/forward from an offline archive is disabled.

Export chooses an account, EML or MBOX, and a destination directory. It creates a new `legalwork-mail-<job-id>` subdirectory. Portable output is plaintext, including attachments; the Settings flow states this before the native picker. Use the encrypted backup feature for an encrypted whole-store backup instead.

## Format and fidelity

A version-1 bundle contains `manifest.ndjson`, either `messages/<ordinal>.eml` files or `messages.mbox`, and an export ownership marker. The manifest starts with a format/version/namespace record, includes folder records (including empty folders), one record per message, and a required completion record with message/byte/failure counts. Missing completion records are incomplete exports, never successful empty archives.

Each message records exact raw byte length and SHA-256, original provider, source account ID and locator as **untrusted provenance**, received date, read state, folder/label membership and folder hierarchy. Export snapshots these values, raw references and all folders in the same database transaction as creation of its job. Subsequent provider changes do not change that snapshot. Existing imported origin provenance survives another export. Import allocates its own account and namespace; source account IDs, owner IDs, credentials and matter authorization cannot be supplied in a manifest. Unknown fields are rejected.

The raw bytes are the original retained MIME representation, not a reconstruction from a displayed body. EML preserves every byte. MBOX output quotes line-leading `>*From ` using mboxrd rules; the manifest bounds the exact decoded raw length and accounts for the one framing newline. This preserves CRLF/LF, binary payloads, quoted From lines and a missing final newline. Raw hashes are validated through EOF before publication; decoded attachments use the existing encrypted content pipeline.

An ordinary MBOX without a manifest has no reliable original per-message byte-length or folder/label inventory. The importer adopts the explicitly selected **mboxrd** interpretation; it retains decoded message bytes through the next ctime-style envelope. Other MBOX dialects and ambiguous unescaped envelope lines cannot be reliably auto-detected; selecting mboxrd asserts that the source uses those quoting rules. Content-Length framing, compressed mailboxes, PST and MSG are unsupported. Convert to EML first when the source dialect is unknown. RFC 4155 describes the variation between MBOX implementations and the need to identify their conventions. [RFC 4155](https://www.rfc-editor.org/rfc/rfc4155)

Plain EML uses its relative path as the source entry ID and directory path as folder provenance. Its MIME Date header supplies the date when no manifest provides the provider's received date; these two dates are not interchangeable. Plain formats cannot restore provider labels they never contained.

## Recovery, bounds and failures

One portability operation runs at a time. File reads, writes and transforms use at most 64 KiB chunks; directory traversal has a 64-level depth bound. The manifest reader caps a line at 256 KiB. No whole-mailbox array or whole-MBOX buffer is built. Per-message metadata allows 256 folder definitions/memberships. Raw import is capped at 256 MiB per message; the existing MIME projection limits still apply, including 32 MiB per decoded attachment. Unsupported or malformed projections leave their original available and report an attention count. Extraction/search incompleteness remains visible through the existing reader/search UI.

MBOX resumes from the last acknowledged envelope byte offset. Bundles resume from their acknowledged message record; the manifest hash must remain unchanged. EML directory retries walk the tree again, verify completed entries and use the same account/namespace/path identity. Two distinct entries with the same Message-ID or even identical MIME remain two messages; blob reuse does not merge identities. Starting another import deliberately creates another archive. Sources are read only, symlinks within bundles/directories and escaping manifest paths are rejected, and source changes fail visibly.

Raw publication and the import entry reference commit atomically. Interrupted projections can be retried without downloading or duplicating raw content. A stopped worker leaves interrupted state; Settings Resume continues the stored job. Unpublished staging from that isolated import is cleared before resumption. Pause is explicit and persisted. Errors expose fixed classifications, not provider or filesystem exception contents.

Export loops handle partial `FileHandle.write` results. Output and manifest files are fsynced before database acknowledgement. EML writes a fresh temporary file, renames it, and fsyncs the containing directory on POSIX. Restart truncates any unacknowledged MBOX/manifest tail. Windows uses the same write-all, file flush, rename and integrity checks; Node does not expose a portable directory fsync there, so this implementation does **not** certify sudden-power-loss directory-entry durability on Windows. A corrupt or missing exported file fails subsequent bundle verification. Keep the source archive until the exported bundle has been verified.

## PST route and Microsoft 365 archive mail

PST conversion is an external local preparation step. The assessed libpst route is `readpst -e -j 1 -o <empty-output-directory> <copy.pst>`: `-e` produces separate EML files in a folder structure with embedded attachments; `-j 1` bounds worker concurrency. Record the converter version, retain the source PST hash, collect diagnostics, and compare converted counts, dates, folder names and attachment hashes against the source inventory. Do not use attachment-dropping options. This imports the converter's MIME output; it cannot attest original SMTP bytes that the PST did not retain. [libpst readpst manual](https://www.five-ten-sg.com/libpst/rn01re01.html)

Thunderbird is another preparation route when the supported source installation is available. Its Outlook import requires Outlook installed; a PST file alone is insufficient. The documented ZIP import limit is 2 GB; larger Thunderbird transfers use a profile-folder source. These are prerequisites, not evidence that an arbitrary PST converted correctly. [Thunderbird import documentation](https://support.mozilla.org/en-US/kb/thunderbird-import)

For an Exchange Online in-place archive, have the authorized administrator use Purview eDiscovery with the required export license and case access. Create/select the case and mailbox search; review statistics and errors, then Export with items and the items report. Choose PST, retain source folders, include required partially indexed items, and keep source locations separate. Primary and associated archives may still merge into one PST. Download all packages and reports within 14 days; compare counts and failures before local conversion. Preserve `items.csv` as external provenance. This procedure does not treat ordinary Graph synchronization as an archive export. [Microsoft export procedure](https://learn.microsoft.com/en-us/purview/edisc-search-export)

The administrator needs appropriate case/search/export roles; eDiscovery Manager includes these, with case-access limits. Verify the selected operator's actual permissions instead of assuming a general administrator role supplies them. [Microsoft eDiscovery permissions](https://learn.microsoft.com/en-us/purview/edisc-permissions)

### Qualification recorded on 2026-09-12

The implementation and synthetic tests ran on macOS arm64, Node 24.11.0 and the installed Electron renderer. `command -v readpst` found no converter; `/Applications/Thunderbird.app` was absent. Outlook 16.112.4 was present (bundle metadata only; no app/profile/mailbox was opened). No converter was installed, no real PST conversion was executed, and no licensed Purview tenant/export was accessed. Therefore the enterprise routes are **documented and prerequisite-checked, not real-account certified**. Execute conversion acceptance on a representative authorized PST/tenant before claiming deployment qualification. Windows OS execution and power-loss testing also remain qualification gates.

## Focused evidence and reproduction

Use existing dependencies and real OS HOME; each fixture owns an isolated temporary encrypted profile. No provider network or live mailbox is used.

```sh
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite storage/archive-schema
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite portability/formats
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite storage/portability
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite runtime/portability
pnpm exec node --test apps/desktop/electron/mail-portability.test.mjs
pnpm exec bun test apps/app/tests/mail-portability-render.test.ts apps/app/tests/mail-archive-reader-render.test.ts
```

Final focused result: 1 migration test, 6 streaming/format tests, 9 encrypted storage tests, 1 private-worker test, 1 native picker test, and 2 actual-renderer tests passed (20 tests total). Strict mail-production TypeScript compilation passed; no full app or platform suite ran.

Evidence covers migration rollback/reopen with retained encrypted bytes and enforced foreign keys; exact EML/MBOX roundtrips, empty/nested folders and labels; duplicate Message-ID separation; decoded binary attachments; changed source/corrupt bundle/missing footer rejection; outbound and credential guards; atomic export snapshot failure; partial-write handling; interrupted export tail truncation; and private-worker import → MIME → index → reopen without provider configuration. The large resume fixture imports **200 messages / 26,454,800 raw bytes**, pauses after at least 12 durable messages, reopens the encrypted database, and resumes to exactly 200 originals and 200 complete projections.

These are feature tests. They do not substitute for the separately scheduled final design, real-provider and broad application integration reviews (EIG-172/173/174), or for the independent EIG-141 100k-mailbox benchmark.
