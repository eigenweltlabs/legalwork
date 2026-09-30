# Document locations and structure

PDFs and images prepared for Tabular Review now retain page regions and possible relationships between passages. The selected OCR engine still receives every whole page. PP-DocLayoutV3 runs locally beside it; it does not select or replace the OCR engine.

## Preparation

`DocumentPreparation` combines located OCR text with PP-DocLayoutV3 regions. Each saved page has normalized boxes, region kinds, OCR region IDs, reading order, tables, and observed visual marks. OCR text outside detected layout blocks remains in separate regions. A margin position alone does not classify text as handwriting.

The local layout worker uses the bundled Node, ONNX Runtime, and canvas dependencies. It downloads the pinned official PP-DocLayoutV3 ONNX model (130,502,049 bytes, approximately 130.5 MB / 124.5 MiB) during automatic local model setup at startup, verifies SHA-256, and reuses it. A fresh default setup installs the small OCR model and layout model together. Existing installations download only the missing layout model; a custom OCR selection is preserved and also gets the shared local layout model. AI Providers shows its download status, cancellation and retry controls. The existing automatic-download opt-out and cancellation preference cover both models; read-only servers never start downloads. Document processing only verifies installed weights and never starts a download. Inference is offline and CPU-based. There is no new Python requirement. Downloads and inference are cancellable; incomplete downloads cannot replace a valid asset.

Preparation format `review-preparation-2` includes layout/model identity in the cache key. Older `review-preparation-1` results remain readable, including their original citations. Preparing again creates new evidence rather than assigning invented locations to old results. Source hashes prevent applying coordinates to a changed file. Successful OCR is saved before layout, so retrying a layout failure or cancellation can reuse its text.

The small built-in OCR engine supplies line coordinates. The Paddle `/layout-parsing` adapter also retains valid block coordinates in the original input image. Plain chat-completions, Mistral markdown, and the current local quality worker do not supply located text; their layout regions are retained, but text-to-region matching is marked incomplete. No extra cloud requests or automatic model substitution are made to guess coordinates.

## Relationships and review

Explicit English/German clause references can connect observed regions. Paragraph and table continuations across adjacent pages are candidates. References with ambiguous numbering remain candidates or are left unresolved. Colored stroke geometry can identify some clear strikeouts and straight headed arrows; these are possible connections, never evidence that an amendment is legally effective.

Review context includes compact block offsets and table metadata. Selection includes connected evidence in both directions, within bounded traversal and context budgets. Incomplete or unlocatable supporting evidence yields “Needs review”. JEV never silently switches to an LLM. Quotations remain checked against the original page text, and OCR citation indices retain their original meaning.

The source viewer's **Layout** control shows regions in reading order. Selecting a region highlights it; selecting a related passage opens its page and highlights the destination. A selected table shows inferred cells where available, with uncertainty visible.

Other tools can consume the same validated structure through `readPreparedDocument(workspace, file, preparationPath)` or authenticated `GET /workspace/:id/document-preparations/document?file=...&preparationPath=...&page=...`. The optional page selector limits page data; the document's relationships remain available for following their endpoints. This adds a reusable read API, not a separate search index.

## Current limits

- OCR mistakes remain OCR mistakes; layout detection does not repair transcription.
- The default small recognizer's dictionary has no Arabic or Cyrillic letters. A layout box on those pages does not imply readable text; a suitable custom OCR provider is needed for those scripts.
- Cell grouping uses OCR coordinates. It does not reliably recover merged cells, spanning headers, or complex grids. Such tables are explicitly uncertain or detection-only.
- Black-ink, faint, curved, and fragmented handwritten marks are not reliably detected. Unconnected notes are not assigned to a clause by proximity alone.
- Handwriting classification, form field/value relationships, and an article/provision hierarchy are not implemented. Generic text regions and continuation candidates do not provide these capabilities.
- Clause linking currently recognizes English/German reference wording. Page geometry and OCR content are not restricted to those languages.
- A completed layout pass describes processing status, not a guarantee that every visible region or handwritten change was understood.

## Verification

Focused automated tests cover layout/line association, unmatched margin text, text-only providers, reference ambiguity, cross-page context, table grouping, colored-mark positive/negative cases, source hash checks, rotated PDF highlights, cancellation, and cache reuse. The optional `LEGALWORK_TEST_LAYOUT_MODEL=1` test runs the actual ONNX model with a repository image when its pinned weights are cached.

A development smoke run on the existing C01 contract (4 pages), C02 claim form (2 pages), and en_paper_11 table page processed all seven pages using the actual small OCR and native layout models in approximately 43 seconds on the development Mac; reuse took approximately 0.25 seconds. It produced 198 combined page regions and one candidate table grid with 26 cells. It produced **no automatic handwritten amendment connections on C01/C02**. This is an integration check, not a measured accuracy score or a completed benchmark of amendment understanding.

The expanded development benchmark is unfinished: 588 of 901 whole-page images completed, three attempts were interrupted by a memory-pressure guard, and 310 were not attempted. All 319 DocLayNet layout pages completed: location-only F1 was 0.914 at IoU 0.5, falling to 0.628 when region types also had to match. On the attempted table scope, 79 of 109 annotated tables were located, but no complete table grid matched. These partial results support page-location inspection, not a claim of reliable table reconstruction or amendment understanding. The run used fixed 200-dpi PDF-derived images and source-resolution forms; it did not test the normal 144-dpi PDF rendering path or downstream review answers. Its frozen source snapshot predates the PR integration; completing and extending the benchmark remains separate work.
