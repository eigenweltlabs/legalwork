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

During ingestion, extraction, indexing, and query work, a separate coordinator sends an IPC inbox-list request every 500 ms, with at most one request outstanding. The mail process executes the real read store with a 25-row page. The report includes request latency and coordinator/worker event-loop delay. This measures isolation and request responsiveness; it is not an Electron frame-rate or full-application responsiveness certification.

Worker peak RSS comes from the process high-water mark. On macOS/Linux, an additional 250 ms process-family sampler reports worker, descendant, and simultaneous combined RSS; short-lived peaks can fall between samples. Descendants include attachment parsers and fresh service workers. Windows runs still report the worker high-water mark and explicitly mark this optional sampler unavailable. The corpus does not exercise OCR; OCR memory/energy needs a separate measured workload.

Storage measurements checkpoint the encrypted WAL before the pre-extraction, pre-index, and final sizes. The report publishes allocated database growth, per-table/index bytes from `dbstat`, raw-MIME amplification, and the additional raw-plus-decoded-attachment denominator. That second denominator deliberately counts both original MIME and decoded parts; it is not a storage efficiency guarantee. CPU time covers the benchmark mail process only. Hardware joules, extractor CPU time, and total-system power are not measured.

## Tuning supported by the pilots

The same 300-message corpus hash produced 36.1 indexed messages/second before tuning and 425.0 afterward. The 25 ms per-document scheduler delay imposed a throughput ceiling, and each background document needlessly recounted mailbox progress. Background turns now return their processed count without a mailbox-wide recount; public rebuild still returns complete progress. A 1 ms yield retains one-document turns and account rotation. Extraction uses a 10 ms delay after work and a 1 s idle delay, preserving one physical process and cancellation/recovery semantics.

A bounded 128-entry native prepared-statement cache reduces repetitive allocation. It clears on explicit SQL execution and close, retains no unbounded SQL history, and preserves parameter binding, transaction rollback, schema-change and rekey behavior.

At 10,000 messages, the first candidate still spent roughly 0.9–1.1 s on broad lexical queries. Query plans showed repeated large encrypted document reads and per-message credential joins. Schema 19 adds compact covering indexes for identity/order and incomplete coverage, plus an external-content FTS5 trigram candidate index for exact substrings. Exact `instr` checks remain authoritative; a partial index retains documents with embedded NUL because SQLite GLOB stops at NUL. Filename candidates use the same JavaScript-normalized text, preserving case-normalization semantics. Address candidates use the already-normalized address FTS column and retain exact JSON equality.

Search validates each requested account inside the same transaction, selects and orders a page of identities before reading bodies/snippets, and prevents SQLite from reordering page rendering into a full FTS-result scan. No message, attachment, dirty state, or access check is discarded to meet a latency number. Schema 19 atomically builds candidates for existing documents; its upgrade cost is distinct from steady-state startup.

## Qualification

The agreed targets in [scope.md](scope.md) are warm p95 ≤300 ms, process-cold first query ≤2 s after service readiness, and mail-worker peak RSS ≤512 MiB on a 16 GiB/local-SSD reference machine. The local measurement host is an Apple M3 Max with 14 logical CPUs and 36 GiB RAM, macOS 24.6.0, Node 24.11.0, and a local APFS SSD. Results on this host do not certify the 16 GiB reference machine, Windows hardware, OS-cold storage, OCR, hardware energy, provider transport, or the full application. Provider/platform/design and broad integration certification remain the final EIG-172/173/174 passes.
