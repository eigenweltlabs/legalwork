# Large-mailbox benchmark (EIG-141)

The benchmark exercises the actual encrypted mail database, raw-content writer, durable sync journal/executor, MIME projector, isolated attachment extraction process, automatic search indexer, read store, and fresh `LocalMailService` workers. It uses synthetic `.invalid` accounts, an isolated temporary directory, and a random test-only encryption key. It never connects a provider or opens an existing user profile.

Run from the repository root with the installed dependencies and actual Node 22 or newer:

```sh
pnpm exec node apps/server/scripts/mail-benchmark.mjs 100000 /tmp/mail-100000.json
```

Use an absolute report path appropriate to the platform. The runner compiles only mail production sources through the installed TypeScript compiler; it does not build the application or run Electron/platform suites. The report includes a SHA-256 of the production/benchmark source inputs, corpus hash, schema version, CPU/OS/runtime, and exact counts. Temporary database and compilation directories are removed by default. For local diagnosis, `LEGALWORK_MAIL_BENCH_KEEP_PROFILE=1` retains only the newly generated synthetic profile; its private `benchmark-profile.json` holds the test key and must stay outside source control. Delete that temporary directory after diagnosis.

## Corpus and completeness

`legal-100k-v3` has exactly 100,000 immutable message identities across three account namespaces. It contains 10,100 messages from 2001, mail dated 2020–2026, inbox/unread/contract labels and a historical archive label, German text and encoded Unicode subjects/filenames, 5,000 missing RFC Message-ID headers, and duplicate RFC Message-IDs both within and across account namespaces. Immutable provider identities remain distinct.

There are 10,100 complete original attachments: 7,000 UTF-8 text files, 1,000 PDFs, 1,000 DOCX files, 1,000 XLSX files, and 100 embedded `.eml` files. Office fixtures use deterministic ZIP entries and the PDF fixtures contain actual extractable page text. Body-size tiers are approximately 768 B, 4 KiB, 16 KiB, and 64 KiB before MIME/Unicode overhead; text-attachment tiers are approximately 2 KiB, 32 KiB, and 256 KiB. The report publishes actual byte distributions and totals. These are varied synthetic documents with repeated legal vocabulary, not a claim to represent every firm's attachment-size mix or scanned-document workload.

Every original raw MIME stream is written and hashed through the production content API in chunks of at most 64 KiB. Attachments are decoded and published by the production projector. The run checks all expected message, raw, attachment, body, projection, and index counts; samples 100 stored raw streams for independent SHA-256 verification; and byte-compares a never-opened original attachment.

Intentional exceptions stay in the timed mailbox and counts:

- 100 MIME messages contain conflicting Content-Type headers. Their complete original bytes remain stored; their body jobs and MIME projections visibly fail as malformed. All 99,900 healthy messages must finish body projection and attachment enumeration.
- 100 oversized UTF-8 attachment outputs exceed the existing extraction output limit; 100 embedded `.eml` attachments have unsupported text extraction. Original attachment bytes remain stored in both cases.
- All 100,000 messages receive search documents. The expected 300 incomplete documents are reported explicitly, and no dirty indexing work may remain. The benchmark does not describe unavailable attachment text or malformed bodies as fully searchable.

The published query set includes broad lexical and phrase matches, German umlauts, old mail, exact punctuated identifiers at opposite ends of the corpus, old never-opened attachment text, PDF/DOCX/XLSX-only hits with part provenance, exact filenames and senders, negative punctuation/address checks, and account/unread filtering. Each query checks its exact expected total; each attachment query checks navigation provenance.

## What is measured

Ingestion runs one MIME job at a time, with batches of 30 descriptors. Extraction uses one physical parser process across accounts. Indexing publishes one document per event-loop turn and rotates accounts. Ingestion, extraction, and indexing are staged to attribute costs separately; provider transport, throttling, network download time, and production interleaving are not simulated.

Warm latency contains ten requests per published query with an event-loop yield between requests; the report gives both aggregate and per-query distributions. Quantiles use the lower order statistic at `floor((n−1) × p)`; maxima are also published. Ten requests per query give a coarse tail estimate, not a high-confidence latency distribution. Each process-cold query opens a new real service/Node worker and SQLite connection, waits for service readiness, issues its first query, and closes it. **The OS filesystem cache is not flushed**. Startup is measured separately from the first query and does not include Electron/UI startup.

During ingestion, extraction, indexing, and query work, a separate coordinator sends an IPC message-list request every 500 ms, with at most one request outstanding. The mail process executes the real read store with a 25-row account page ordered by received date. The report includes request latency and coordinator/worker event-loop delay. This measures isolation and request responsiveness; it is not an Electron frame-rate or full-application responsiveness certification.

Worker peak RSS comes from the process high-water mark. On macOS/Linux, an additional 250 ms process-family sampler reports worker, descendant, and simultaneous combined RSS; short-lived peaks can fall between samples. Descendants include attachment parsers and fresh service workers. Windows runs still report the worker high-water mark and explicitly mark this optional sampler unavailable. The corpus does not exercise OCR; OCR memory/energy needs a separate measured workload.

Storage measurements checkpoint the encrypted WAL before the pre-extraction, pre-index, and final sizes. The report publishes allocated database growth, per-table/index bytes from `dbstat`, raw-MIME amplification, and the additional raw-plus-decoded-attachment denominator. That second denominator deliberately counts both original MIME and decoded parts; it is not a storage efficiency guarantee. CPU time covers the benchmark mail process only. Hardware joules, extractor CPU time, and total-system power are not measured.

## Tuning supported by the pilots

The same 300-message corpus hash produced 36.1 indexed messages/second before tuning and 425.0 afterward. The 25 ms per-document scheduler delay imposed a throughput ceiling, and each background document needlessly recounted mailbox progress. Background turns now return their processed count without a mailbox-wide recount; public rebuild still returns complete progress. A 1 ms yield retains one-document turns and account rotation. Extraction uses a 10 ms delay after work and a 1 s idle delay, preserving one physical process and cancellation/recovery semantics.

A bounded 128-entry native prepared-statement cache reduces repetitive allocation. It clears on explicit SQL execution and close, retains no unbounded SQL history, and preserves parameter binding, transaction rollback, schema-change and rekey behavior.

At 10,000 messages, the first candidate still spent roughly 0.9–1.1 s on broad lexical queries. Query plans showed repeated large encrypted document reads and per-message credential joins. Schema 19 adds compact covering indexes for identity/order and incomplete coverage, plus an external-content FTS5 trigram candidate index for exact substrings. Exact `instr` checks remain authoritative; a partial index retains documents with embedded NUL because SQLite GLOB stops at NUL. Filename candidates use the same JavaScript-normalized text, preserving case-normalization semantics. Address candidates use the already-normalized address FTS column and retain exact JSON equality.

Search validates each requested account inside the same transaction, selects and orders a page of identities before reading bodies/snippets, and prevents SQLite from reordering page rendering into a full FTS-result scan. No message, attachment, dirty state, or access check is discarded to meet a latency number. Schema 19 atomically builds candidates for existing documents; its upgrade cost is distinct from steady-state startup.

## Completed frozen 100,000-message result (schema 19)

The immutable [raw report](benchmarks/legal-100k-v3-schema19.json) measures source SHA-256 `1084752e053f2a3d3d1b6b604ca884fe44fec31bc907ec63c3c2001bd8398d64`. Its corpus hash is `698fa2c64e3b253dd75455e748f83fc02b29fd6214988a7c6818c119f4d85425`. This run finished; no partial-corpus extrapolation or replacement run supplies its numbers.

| Measurement | Frozen result |
| --- | --- |
| Raw messages / indexed messages / dirty work | 100,000 / 100,000 / 0 |
| Healthy complete projections and attachment enumeration | 99,900 / 99,900 |
| Original attachments / extracted / output-limit / unsupported | 10,100 / 9,900 / 100 / 100 |
| Malformed MIME / incomplete search documents | 100 / 300 |
| Exact query totals and attachment provenance | All 15 queries passed |
| Total elapsed / ingestion / extraction / indexing | 193.97 / 98.89 / 83.08 / 11.16 minutes |
| Ingestion / extraction / indexing throughput | 16.85 messages/s / 2.03 parts/s / 149.34 documents/s |
| Warm aggregate p95 / maximum | **503.54 / 1,055.63 ms; target missed** |
| Broad phrase p95 / maximum | **669.61 / 1,005.98 ms** |
| Process-cold first-query maximum after readiness | 622.86 ms |
| Service startup p95 / maximum | 948.20 / 948.72 ms |
| Worker peak RSS / sampled simultaneous process family | 342.86 / 423.25 MiB |
| Raw MIME / decoded attachments | 274,434,173 / 72,630,300 bytes |
| Final encrypted DB / WAL / index-stage growth | 1,920,036,864 / 0 / 641,974,272 bytes |
| DB/raw amplification / DB/(raw + decoded attachment) | 7.00× / 5.53× |
| Foreground IPC read p95 / maximum, all phases | 1,400.51 / **15,759.96 ms** |
| Ingestion foreground IPC read p95 / maximum | **1,662.20 / 2,850.17 ms** |

Raw MIME p50/p95/max is 1,202 / 4,653 / 375,269 bytes. Decoded attachment p50/p95/max is 2,226 / 34,226 / 273,151 bytes. Large allocations include search documents (577,249,280 bytes), blob chunks (567,349,248), local events (122,462,208), MIME projections (68,374,528), and extraction rows (57,823,232). Full per-table and distribution denominators remain in the raw report.

### Stall attribution and current-schema correction

The frozen foreground maximum remains unchanged. A separate encrypted clone reproduced the exact full `dbstat` accounting statement at **16,940.65 ms** synchronously. The original harness ran this statement inside its `query` phase after all search requests; its 15.76-second sample is accounting contention, not a normal search or UI operation. Future runs label that work `accounting`, while still retaining its foreground measurements. The original ingestion p95 cannot be explained away by that scan.

A 30-message ingestion probe into an existing 33k-message account on the retained clone exposed the ingestion bottleneck: `MailSyncJournal.linkMessageChildren` repeatedly scanned account-wide scope/job membership during the atomic page commit. Individual statements took 200–654 ms; the body-job batch took 6,891.89 ms and stalled a 10 ms timer for 6,817.37 ms. An otherwise similar empty-account probe took 229 ms total, demonstrating the account-cardinality effect. This is a bounded reproduction of the blocking mechanism; the original run did not retain per-statement timing, so it does not assign an exact fraction of every historical p95 sample to that statement.

Schema 28 adds the reverse `(account_id,job_id,generation)` scope index. The closure query starts from the exact raw parent before enumerating its scopes and children. Raw/body/attachment identity, generation, current and later scope inheritance, transactions, and lease checks remain intact. The measured index occupies 10,047,488 bytes on the follow-up clone. No executor scheduler or provider transport changes are required.

The phrase path now materializes authorized match identities once for both exact count and page selection. It reads only the selected bodies for snippets; it preserves account and matter-source scope, structured filters, dirty-document exclusion, deterministic ordering, empty-page totals, and attachment provenance. The change avoids decoding broad phrase postings twice. The [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html) describes the positional match and query-dependent snippet behavior; measurements, rather than removing phrase or substring semantics, motivated this change.

### Matched retained-corpus follow-up

The [schema-27 comparator](benchmarks/legal-100k-schema27-comparator.json) uses production code from `c2cc42f60` plus the same retained-corpus harness as the [shipped schema-28 follow-up](benchmarks/legal-100k-schema28-follow-up.json). Both clone the immutable source file, migrate only the copy, test every published query, verify 100 retained raw hashes, and append only two 30-message contention probes. They do **not** regenerate the corpus or repeat full ingestion, extraction, or indexing. Each report binds the original report hash and its own source hash.

| Same follow-up protocol | Schema 27 | Schema 28 |
| --- | ---: | ---: |
| Exact query totals / raw hashes | 15 / 100 passed | 15 / 100 passed |
| Primed warm aggregate p95 / maximum | 484.77 / 536.72 ms | **261.23 / 275.21 ms** |
| Body-only page commit, 30 messages | 6,132.56 ms | **38.15 ms** |
| Raw + body page commit, 30 messages / 60 jobs | 6,353.82 ms | **206.81 ms** |
| Body-only maximum foreground timer interval | 6,251.77 ms | **174.83 ms** |
| Raw + body maximum foreground timer interval | 6,484.37 ms | **322.52 ms** |

These warm samples use one first call per query reported separately, followed by ten measured calls (150 total). That explicit priming differs from the original frozen protocol; use the matched comparator for the optimization effect. Schema-28 first calls reached 868.05 ms, and broad phrase first call was 361.53 ms. These are calls on the same post-migration connection, not new process-cold measurements. The full schema-19→28 clone migration took 31.45 s, including intervening archive/schema migrations and foreign-key validation; it is neither steady-state startup nor an isolated schema-27→28 migration measurement.

The contention probes call the production 25-row received-date reader from a 50 ms worker timer. Timer intervals include scheduling delay and the synchronous reader cost. They are **not IPC or Electron frame timings** and do not replace the frozen foreground p95. The raw-parent probe starts from locally stored synthetic raw bytes and completes its raw journal job without provider transport. It still exercises the actual page commit, scope closure, executor, MIME projection, encrypted publication, and concurrent reader. No full-mailbox throughput improvement is inferred from these 30-message batches.

Reproduce the follow-up against a deliberately retained synthetic profile, using a new report filename:

```sh
pnpm exec node apps/server/scripts/mail-benchmark.mjs --retained /absolute/path/to/synthetic-profile /tmp/new-follow-up.json
```

The runner rejects a non-benchmark profile marker or a non-100k count, checks account ownership on the clone, writes a new report exclusively, checks original database size/mtime, and removes its copy. Never pass a regular development/user mail profile or commit its private test-key file. The committed frozen report and both follow-up reports contain synthetic measurements only.

## Qualification

The agreed targets in [scope.md](scope.md) are warm p95 ≤300 ms, process-cold first query ≤2 s after service readiness, and mail-worker peak RSS ≤512 MiB on a 16 GiB/local-SSD reference machine. The local measurement host is an Apple M3 Max with 14 logical CPUs and 36 GiB RAM, macOS 15.6.1 (Darwin 24.6.0), Node 24.11.0, and a local APFS SSD. This is an active development machine; other agents ran short scoped tests while the long benchmark ran. The machine was not reserved as an idle reference host. Results on this host do not certify the 16 GiB reference machine, Windows hardware, OS-cold storage, OCR, hardware energy, provider transport, or the full application. Provider/platform/design and broad integration certification remain the final EIG-172/173/174 passes.

## Focused checks and exclusions

The ticket's focused runs passed 10 native encrypted-database tests, 12 search behavior/migration tests, 6 extraction-storage tests, and the shared-account authorization/revocation case. Mail production sources compile in the benchmark and acceptance runners. The final 300-message smoke run exercised all 15 published queries and the complete storage/extraction/indexing path.

The 12-test search run used `--test-name-pattern` and **excluded** the legacy `v7 upgrade is atomic, idempotent and rebuilds existing locally stored mail` fixture. That fixture contains an undefined `db.exec` reference and requires its downgrade setup to account for newer schemas. Its failure is not a passing test and is not covered by the 12-test count. The root integration task subsequently repaired the legacy downgrade fixtures through schema 20 in `6b8559033`; its 14 focused migration/upgrade cases passed, including that previously excluded v7 fixture. Those later integration checks do not change the frozen schema-19 benchmark source or retroactively add tests to the original 12-test run; the new schema-19 rollback/idempotency/existing-document test passed separately within the 12. No full Electron/application/platform suite was run for EIG-141.


Current schema-28 focused verification ran the complete `storage/search` suite (**14/14**, no exclusions) and complete `storage/sync-journal` suite (**20/20**, no exclusions), each through `pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite <suite>`. This includes the repaired v7 fixture, the new phrase total/empty-page/account/source-scope/dirty/reopen fixture, schema-28 DDL fault rollback/idempotency/reopen/foreign-key preservation, and existing raw followup inheritance plus before/after SIGKILL cases. The legacy downgrade helper now removes the reverse index before recreating pre-28 schemas. The current compiler also passed in both retained benchmark runs. No full app or platform suite was added.

Review follow-up adds combined phrase + unread/folder/date/literal/sender/filename/attachment filters to the existing lexical fixture, with positive and negative exact results. The existing agent source-version fixture now performs a positive phrase/literal search through a valid V1 filing receipt, then confirms the V2 phrase is excluded after source replacement. Both changed fixtures passed individually after the complete-suite runs above; no broad suite or benchmark was repeated for these test-only additions.
