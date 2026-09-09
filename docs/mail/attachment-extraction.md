# Local attachment extraction — EIG-138

Downloaded attachments are automatically queued, extracted in a separate local process, and indexed by the existing encrypted FTS5 search. No provider request, upload, external search service, temporary plaintext file, or runtime model download is involved. Original bytes are unchanged. Extraction completeness is separate from download and MIME completeness.

## Supported inputs and provenance

- UTF-8 text and BOM-marked UTF-16 text: TXT, Markdown, CSV, TSV, JSON and XML (or text/plain). Invalid encoding fails visibly.
- DOCX: document, headers, footers, footnotes and endnotes. PPTX: slide text in slide order. XLSX: inline/shared strings and cached cell values; formulas and macros are never executed. ZIP/XML are parsed in memory; DTDs are rejected.
- PDF: native text and German/English OCR of scanned or raster-containing pages, including a digital stamp over a scanned body. Native text is retained alongside OCR. PDF image dimensions are checked before PDF.js decoding; oversize images fail instead of yielding a misleading successful empty projection.
- PNG/JPEG: German/English OCR, after dimension checks.

Legacy binary Office files, other formats and unsupported image encodings fail as `unsupported`; password-protected PDFs fail as `encrypted`. Malformed and over-budget documents have explicit terminal errors. OCR is approximate and is not a substitute for the original. Diagrams, Office drawing text, embedded objects, handwriting and layout reconstruction are outside the supported text projection.

Each result binds owner/account, message locator, attachment part, immutable content reference and extractor version `local-text-v1`. Sections identify the source page, ZIP entry or text/image and whether extraction used text or OCR. Search includes at most eight complete attachment projections per message, adding at most 2 MiB to the existing bounded MIME body; `incomplete` remains true for pending/failed or excess attachments. Search `attachmentSources` lists the exact current parts included in the index, not a claim that each part matched the query. The read API supplies full bounded section pagination.

## Local API

Host-token-only loopback POST operations under `/mail/v1/accounts/:accountId/attachments/extraction/`:

- `status`: `{locator, partId, referenceId}` → downloaded flag, queued/running/complete/failed state, attempts, fixed error and section count.
- `read`: same identity plus optional `section`, `offset`, `limit` (default 4096, maximum 8192 UTF-16 code units) → status, source, method, text, echoed offset and nextOffset/nextSection. Start a new section at offset zero.
- `reset`: same identity → durably invalidates the previous lease/result and queues a new attempt; this is the explicit re-extraction operation.

All identity fields are strict and current-manifest scoped. Foreign accounts, wrong refs, locked/disconnected archives and remote/collaborator access are rejected before text. Existing service epoch checks fence responses across lock/disconnect/reopen. Results use no-store HTTP caching. No arbitrary filesystem paths, executable/model URLs or blob IDs are accepted.

## Durability, lifecycle and limits

The additive extraction migration seeds existing stored attachments and triggers queueing on new attachment publication. One physical process is active globally, with account rotation between jobs. An encrypted lease lasts 120 seconds; interrupted work is reclaimed with a maximum of three attempts. Parser failures remain visible until explicit reset. Reset, replaced manifests, credential generations and close/disconnect fence late results. Closing kills and reaps the process before releasing its slot. No parser runs inside a database transaction.

Input is capped at 8 MiB; ZIP expansion at 16 MiB, each entry at 4 MiB and 1000 entries; PDFs at 30 pages; source/rendered images at 4 million pixels; result JSON at 256 KiB. A process wall deadline is 90 seconds, with an independent parent kill deadline of 91 seconds. The worker thread has a 256 MiB V8 old-generation limit; the supervising process samples whole-process RSS every 50 ms and terminates above 768 MiB. Sampling cannot prevent an instantaneous native allocation spike; this is resource containment, not an OS sandbox or hard resident-memory quota. Parent output bytes are capped before fatal UTF-8 decoding; split Unicode pipe chunks are preserved.

Text and job state are stored only in the encrypted mail database/WAL. Raw replacement removes old projections from current read/search eligibility while retaining immutable historical bytes/results. Remote deletion retains archives according to existing mail policy. Extraction updates mark search dirty and emit ID-only message events; recovery/reindex reads local stored results and content. Pending download status does not claim extracted text.

## Runtime and dependency contract

Server and desktop mirror exact pins: pdfjs-dist 6.3.289 (Apache-2.0), pdf-lib 1.17.1 (MIT), @napi-rs/canvas 1.0.8 (MIT), tesseract.js 7.0.0 (Apache-2.0), @tesseract.js-data/eng and /deu 1.0.0 (MIT package wrappers; upstream Tesseract trained data Apache-2.0), saxes 6.0.0 (ISC), and existing fflate 0.8.3 (MIT). PDF.js requires Node >=22.13. The desktop Electron Node runtime satisfies that requirement.

`patches/tesseract.js@7.0.0.patch` corrects worker-script/index.js initialize mapping from `l.data` to `l.code` for documented `{code,data}` language objects. The pinned source's loadLanguage path already uses `code` for the model filename and `data` for bytes. Without this correction, initialize treats the entire model byte buffer as a language name and exceeds the watchdog. Models are loaded from installed gzip assets with cacheMethod `none`, rather than URLs or cache files. The patch is recorded in pnpm's lock and patchedDependencies.

Electron packaging explicitly unpacks canvas platform binaries, Tesseract worker/core/WASM, local eng/deu model packages and PDF.js assets, including pnpm layouts. Canvas publishes the required macOS arm64/x64 and Windows x64 packages; those platforms must retain their optional dependency at install/package time. This feature's focused runtime test actually exercised Electron 35.7.5 on macOS arm64 with native canvas, PDF rendering and local bilingual OCR. Intel/Windows execution and full app packaging were not run for this ticket; no qualification claim is made.

Primary API references: [Tesseract API and language buffers](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [local runtime assets](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [PDF.js parameters](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html), [canvas platform support](https://github.com/Brooooooklyn/canvas), [fflate streaming](https://github.com/101arrowz/fflate). PDF.js is invoked with `isEvalSupported:false`; the pinned v6 implementation no longer exposes that legacy option, so the option itself is not a security guarantee.

## Focused acceptance

Run from the repository root with installed pnpm dependencies:

```
node apps/server/scripts/mail-acceptance.mjs --suite extraction/extract --concurrency 1
node apps/server/scripts/mail-acceptance.mjs --suite storage/extraction --concurrency 1
pnpm --dir apps/server exec bun test src/mail/extraction.e2e.test.ts
```

The first suite accepts `LEGALWORK_MAIL_TEST_ELECTRON` pointing to an existing Electron executable. Seven parser cases cover actual Office/PDF/scan and bilingual Electron OCR, Unicode pipe boundaries, malformed/encrypted inputs, ZIP/page/image budgets and kill/reap. Six encrypted Node cases cover indexing/provenance, DB/WAL plaintext-marker absence, restart/leases, reference replacement, reset, OAuth/IMAP account/disconnect fencing and independent failed-extraction status. The HTTP case exercises the real Node worker behind the host API, including pagination, search, authorization, reset, lock and reopen. No live mailbox or broad application build is used.
