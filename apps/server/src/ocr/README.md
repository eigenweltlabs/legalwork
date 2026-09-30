# Shared OCR foundation

The recognition service is independent of Tabular Review and PDF tools. Host settings
are exposed in Settings → AI Providers → Document recognition (OCR).
It recognizes every page supplied by a caller, using an explicitly selected engine.
There is no handwriting detector, page-skipping policy, automatic engine switch or
remote fallback. `local-fast` is the default. PDF reading/rendering stays with the
calling tool; this interface accepts rendered PNG, JPEG or WebP pages.

## Call from a tool

```ts
import { createConfiguredOcrService, OcrSettingsStore } from "./index.js";

// Paths and secret lookup come from the embedding host, never from document text
// or an untrusted agent-supplied endpoint/command. Reuse one service per host.
const store = new OcrSettingsStore("/application-data/ocr/settings.json");
const service = createConfiguredOcrService(await store.read(), {
  localRuntime: {
    python: "/application-data/ocr/venv/bin/python",
    workerPath: "/installation/resources/ocr/worker.py",
    modelDirectory: "/application-data/ocr/models",
  },
  resolveApiKey: async (reference) => hostSecretStore.get(reference),
});

const result = await service.extract({
  sourceId: document.id,
  languages: ["en", "de"],
  // Omit to use the saved default. The user may explicitly choose a server ID.
  engineId: "local-fast",
  pages: [{ pageNumber: 1, mimeType: "image/png", width, height, data: pageBytes }],
  signal: abortController.signal,
  onProgress(event) {
    // Show engine, local/remote execution and warnings before work starts.
    // Persist page-completed results if the consumer needs resumable jobs.
  },
});
```

The example's `hostSecretStore`, `document`, page renderer and UI/job lifecycle are
provided by the caller. This module does not register agent tools or access arbitrary
document paths. The caller must authorize files/workspaces and any settings changes.
It must show that a selected server receives the page images; configuring a remote
default is an explicit host/user choice, never a consequence of local failure.

`OcrService` also accepts independent `OcrEngine` implementations. Add a provider
adapter there when an API uses a different protocol. Consumers receive the same
result structure and do not need to know the model implementation.

## Results and warnings

- Every page retains its input page number, dimensions and SHA-256. `sourceId` belongs
  to the caller. Re-extraction produces a new result; it does not overwrite anything.
- Fast OCR includes normalized bounding rectangles (top-left origin, range 0–1).
  Map them to the exact rendered page using its width/height and the renderer's PDF
  transform, including crop/rotation. The module does not invent PDF coordinates.
- Given layout `blocks` (review preparation passes PP-DocLayoutV3 blocks and masks after
  PaddleX layout post-processing), the quality model runs the PaddleOCR-VL block pipeline,
  ported from PaddleX to TypeScript (`vl-blocks.ts`, `vl-outlines.ts`): layout outlines from
  the masks, outline-aware overlap filtering and crops, block merging, per-label prompts
  (`OCR:`, `Table Recognition:`, `Formula Recognition:`) and repetition truncation. The
  OpenCV calls it relies on are ported with OpenCV's float32 rounding, so crops match
  Paddle's pixel for pixel, except that figure tokens in tables are drawn in Liberation Sans
  instead of OpenCV's Hershey font. Each crop is then resized exactly like Paddle's image
  processor (smart_resize to multiples of 28 pixels, PIL's bicubic resampling), so the model
  runtime does not resample it its own way; llama.cpp's own resampling dropped closing
  quotation marks. The model reads the crops in llama.cpp's `llama-server`.
  Settings are PaddleOCR-VL's defaults except `use_ocr_for_image_block`, which is on:
  image blocks are read; chart and seal blocks are not. Pictures inside tables become `[image]` plus their text in the cell.
  Tables carry their OTSL cell grid and appear in the text as plain `a | b | c` rows, so
  quotes match without HTML.
- Beyond PaddleOCR-VL, the fast model's text-line detector runs on the page (up to 2,000 px
  on the longest side, so isolated page numbers are found); lines outside
  every layout block are read one by one, so text the layout model missed is kept.
  Blocks with layout confidence below 0.5 are only read when the detector found text in
  them: the model cannot answer "nothing here" and invents text for scan noise. Output
  that runs into the 4,096-token limit is dropped instead of trimmed (a loop or invented
  text) and reported as truncated, so the page needs review.
  Each region is one recognized block or line. Without layout the whole page is read;
  when layout found no blocks, only the detected lines are read.
  Custom API adapters return page-level text and no regions.
  `regions-unavailable` prevents consumers from implying exact regional citations.
- Scores from fast OCR are engine scores, not calibrated correctness probabilities.
- All runs warn `recognition-errors-possible`; fast runs additionally warn
  `fast-model-limitations`. Suggested copy: “Handwriting and complex layouts may
  contain recognition errors. Review the text or retry with another model.”
- Unsupported declared languages fail before processing. Fast OCR deliberately
  advertises a conservative subset of the model's languages. Other script families
  need additional recognizer adapters/packs. `languages: null` means unverified
  support and produces a warning, not a claim of universal support.
- Blank text and generation limits are explicitly flagged. Text is untrusted source
  material, never an instruction for the host or an assertion of legal correctness.

Each engine reads as many pages at once as it declares: local models one, remote APIs two;
a page's time limit starts when it gets its turn. Limits are 100 pages, 20 MiB
per page, 64 MiB total image data, 40 million pixels per page and 4 MiB per engine
response. Larger documents can be submitted as batches preserving page numbers.
The default deadline is 120 seconds per page (configurable up to 600 seconds).
Cancellation terminates the local worker or aborts the HTTP request. Custom adapters
must honor their `AbortSignal`. A failure rejects the job; completed pages have already
been emitted through progress. There are no automatic retries or paid API retries.

## Provision local models

On startup, a writable server automatically prepares the small model in the
background when `local-fast` is the saved default and its installation is missing.
This includes the first launch after an application update. Startup does not wait
for downloads; Settings shows progress, cancellation and the existing Download model
retry control. Ready installations are reused. Selecting a custom or higher-quality
default skips automatic setup; the larger model remains an explicit download.

The small model uses bundled native ONNX Runtime, the `paddleocr` JavaScript
pipeline and the image decoder already shipped for PDF rendering. It needs no
Python, `uv`, dependency installation or administrator rights. Setup downloads only
the official, revision-pinned detector/recognizer and dictionary configuration
(about 31.2 MB), checks exact sizes and SHA-256 digests, then recognizes a built-in
sample before reporting Ready. Downloads publish atomically; complete verified
assets are reused on retry. Extraction uses explicit local paths and disables fetch.

`native-worker.cjs` and `layout-worker.cjs` run in separate processes using the desktop's
bundled Node. Only the host's OS/locale variables and explicit module directory are
forwarded. They stay loaded between pages (one JSON request and reply per line), stop
when the engine closes or after two idle minutes, and are killed on a timeout or
cancellation. The worker returns normalized regions through the existing OCR interface.
Existing Python-provisioned small-model manifests/weights are reused without needing the
old Python environment. Review evidence gets a new cache fingerprint when switching to
native recognition.

Desktop builds unpack the worker's libraries outside ASAR and remove other
platforms' ONNX binaries. ONNX Runtime 1.23.2 is pinned because later npm releases
omit Intel macOS binaries. The target binding is required at packaging time.
Measured on macOS ARM64: approximately 39 MB additional installed libraries (11 MB as a gzip
archive), reusing existing Canvas and Node; the final installer delta depends on
its compression. Windows/Linux sizes and native execution require separate checks.

The optional higher-quality model needs no Python either. Its explicit setup downloads
Paddle's official `PaddlePaddle/PaddleOCR-VL-1.6-GGUF` release (Apache-2.0, about 1.8 GB)
and an official llama.cpp build (MIT, `b11234`, about 12 MB), both revision-pinned and
checksum-verified, streamed to disk and published atomically. Only a macOS Apple Silicon
build is pinned so far; other platforms report the model as unsupported. Installations
from the earlier Python/MLX runtime are prepared again; their files are not reused.

`llama-server` starts on the first page of a job, keeps the model loaded, and stops when
the job ends or after two idle minutes. It listens on 127.0.0.1 behind a per-run API key,
without its web UI or slot inspection. `llama-launcher.cjs` runs it and stops it when this
process exits, even abruptly. Cancelling a page stops only that answer. The server has two
reading slots and receives a page's crops two at a time: that answered 53 crops 21% faster
than one slot with identical text, using about 2.9 GB of memory.

Cancelling small-model setup is remembered across restarts; Download model clears
that cancellation and retries. Failed setup retries on the next launch, or manually
from Settings. Closing the application cancels running setup without disabling the
next startup attempt. To disable automatic setup for a deployment, set
`LEGALWORK_OCR_AUTO_DOWNLOAD=0` or `"autoDownloadOcr": false` in the server config.
Read-only servers never start automatic downloads. Extraction itself never installs
models; callers still need to wait for the selected model to become ready.

`apps/server/resources/ocr/` is included in server package files and Electron's
external resources, so workers remain outside ASAR. Npm/server installations also
need the declared native runtime dependencies next to the server package. The
manual Python setup below remains available for embedding hosts that explicitly
provide a Python worker instead of `OcrRuntime`'s bundled native worker.

Example from `apps/server`, using Python 3.12 and `uv`:

```sh
uv venv --python 3.12 /application-data/ocr/venv
uv pip install --python /application-data/ocr/venv/bin/python -r resources/ocr/requirements-fast.txt
/application-data/ocr/venv/bin/python resources/ocr/prepare.py --model pp-ocrv6-small --model-dir /application-data/ocr/models
```

Use the equivalent `Scripts/python.exe` path on Windows. The fast adapter uses
ONNX Runtime CPU with four threads. This implementation was exercised on macOS
Apple Silicon; Windows/Linux packaging and hardware testing remain separate work.

Setup pins detector/recognizer snapshot revisions. Model manifests reference the
Hugging Face cache, so that cache must remain installed. The fast dictionary and
unused-but-constructed orientation classifier are provisioned explicitly too. The Python
worker uses local model paths and offline Hugging Face settings, validates the required
assets before constructing RapidOCR, and starts once per page. Missing assets fail rather
than trigger installation.

Document preparation reads one page ahead: while the model reads a page, the next is
rendered and laid out.

## Configure a server

```ts
const settings = await store.read();
settings.engines.push({
  id: "team-ocr", label: "Team OCR", kind: "chat-completions",
  endpoint: "https://ocr.example.org/v1/chat/completions",
  model: "the-server-model-id", apiKeyRef: "ocr/team-key",
  languages: null, maxTokens: 8192,
});
// Optional: settings.defaultEngineId = "team-ocr";
await store.write(settings);
// Recreate the service with this settings snapshot after saving changes.
```

Custom models support three explicit API types:

- `chat-completions`: vision Chat Completions with inline image data, `max_tokens`,
  and a standard choices/message response. Existing configurations keep this type.
- `mistral-ocr`: `/v1/ocr`, with an inline `image_url` document and page Markdown
  results. The model ID is configurable (for example `mistral-ocr-latest`).
- `paddleocr`: `/layout-parsing`, with base64 `file` and `fileType: 1`. Reads the
  single image's `result.layoutParsingResults[0].markdown.text`. Model selection
  belongs to the deployed PaddleOCR pipeline; the UI therefore omits a model-ID
  field for this API. The stored model label is `PaddleOCR`.

The latter two adapters preserve returned Markdown in the text result. They do not
download linked images or claim word coordinates. Each request processes one supplied
page image, so responses with multiple pages are rejected rather than misattributed.
HTTPS is required except for loopback HTTP. Redirects, URL credentials and query-
string keys are rejected. Only the current page image (plus language hints for Chat
Completions) is sent;
no local filename or document ID is included. No real external API was called in
verification; all three contracts were tested against loopback HTTP fixtures.

Protocol references: [Mistral OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr)
and [PaddleOCR serving](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.en.md).

Settings store only the key reference. Implement `resolveApiKey` using the host's
OS keychain or secret vault (an environment-variable resolver also works for server
deployments). Raw keys are not accepted by the settings schema, returned in engine
metadata, forwarded to local workers by this module, or put into errors. Provider
error bodies and local stderr are intentionally not surfaced. Local workers inherit
only basic OS/path/locale variables plus offline flags, not host API-key environment
variables or `PYTHONPATH`.

## Verification

```sh
pnpm --filter legalwork-server exec bun test src/ocr/ocr.test.ts
pnpm --filter legalwork-server typecheck
```

Native setup/packaging verification (the first command intentionally downloads
the small model into a fresh temporary directory and prints its root):

```sh
pnpm --filter legalwork-server exec bun script/smoke-native-ocr.ts
LEGALWORK_OCR_NATIVE_SMOKE_ROOT=/printed/ocr/root pnpm --filter legalwork-server exec bun test src/ocr/native.test.ts
pnpm --filter @legalwork/desktop exec node scripts/prepare-node-runtime.mjs
LEGALWORK_OCR_NATIVE_SMOKE_ROOT=/printed/ocr/root pnpm --filter @legalwork/desktop exec node scripts/smoke-ocr-package.mjs
pnpm --filter @legalwork/desktop exec node --test electron/packaged-ocr.test.mjs electron/packaged-server-deps.test.mjs
```

The package smoke builds an isolated ASAR/unpacked dependency tree, prunes foreign
ONNX binaries, and runs the real worker with an empty PATH and only shipped modules.
It reports both uncompressed additional libraries and their gzip archive size.
Native recognition checks include English, German, French, Spanish, skewed text,
blank pages, JPEG/WebP and rejected dimension mismatches. They do not replace the
handwriting/contract-quality benchmark or a signed desktop release test.

The tests cover explicit engine selection, no fallback, language and size validation,
coordinates, source identity, warnings, progress, queueing, deadlines, cancellation,
settings persistence, key isolation, bounded responses and the subprocess boundary.

An opt-in real-model smoke test uses the generated bilingual PNG fixture (a functional
test, not the handwriting benchmark). It downloads nothing:

```sh
LEGALWORK_OCR_SMOKE_PYTHON=/application-data/ocr/venv/bin/python LEGALWORK_OCR_SMOKE_MODELS=/application-data/ocr/models pnpm --filter legalwork-server exec bun test src/ocr/ocr.test.ts
```

It exercises the small model's Python fallback. The native smoke test above also reads the
page with the quality model in llama.cpp when that model has been prepared in the root.

## Tabular Review integration

`document-preparation/service.ts` is the shared consumer. Starting a saved review
automatically creates one preparation job for its PDF/image sources before running
their cells. The server pins the selected model, endpoint and credentials for that
run. Agents use the bundled `start-tabular-review` skill and review tools; standalone
OCR preparation tools are not exposed to the agent. DOCX/text continue through their
existing readers.

Every PDF page is rendered with PDF.js at up to 144 dpi (16 million pixels maximum)
and passed to OCR, even when a text layer exists. Native text and recognition results
remain separate. PNG/JPEG/WebP use the same recognition path. Optional language hints
can be omitted; no language is assumed. No model or cloud fallback occurs.

Prepared page evidence is stored with mode 0600 below
`.opencode/legalwork/prepared-documents/` in the workspace. Cache identity includes the
source hash, selected configuration, language hints and preparation version. New runs
retry failed pages and reuse successful ones; `force` repeats recognition of all pages.
Cancellation preserves completed pages. Jobs are serialized to bound model memory.
The API accepts at most 100 documents per run, 64 MiB per file and 1000 pages per PDF. Extracted evidence is bounded to 64 MiB per document.
PDF fonts, CMaps and decoders are embedded for offline rendering in standalone binaries;
regenerate `pdf-assets.ts` with `node scripts/gen-pdf-assets.mjs` when upgrading PDF.js.

Workspace/client-authenticated routes:
- `POST /workspace/:id/document-preparations`: `{files, languages?, force?}` → job snapshot.
- `GET /workspace/:id/document-preparations/:job`: progress and prepared file paths.
- `DELETE /workspace/:id/document-preparations/:job`: cancel. Start a new run to resume.

Starting/cancelling requires collaborator authority and a writable server. Paths are
checked against the workspace, including symlinks. Run metadata is in memory; after a
server restart, start a new run to reuse the persisted page evidence.

The review builder validates quotes against preparation text and checks that source
bytes still match. Cells can cite multiple pages and native/OCR passages. OCR rectangle
coordinates come from prepared regions, never from the agent. Without region output,
citations show the page. Missing, failed or uncertain extraction cannot substantiate
“Not found”. The artifact shows extraction errors and supports source-image previews.
A page needs review when its recognition is uncertain (no text, output dropped at the
limit, `[illegible]`, low line confidence) or its layout structure is incomplete. A page
with no PDF text, no layout block and no recognized text is blank and counts as complete.
Table cells inferred from line positions are marked uncertain on the table, not the page.

JEV column routing, semantic linking of handwritten insertions and the contract-quality
release benchmark remain separate work; OCR integration does not certify clause recall.

## Host settings API

All `/ocr/*` routes require host/owner authorization. Read-only servers expose the
settings but reject all mutations, downloads and sample tests. Configuration lives
in `ocr/` beside the server config. `OcrManager.service()` constructs a service using
these saved choices and managed local runtime; tool hosts should reuse their service
for jobs and refresh it when settings change.

- `GET /ocr/settings`: public configuration, model readiness and download stage.
- `PUT /ocr/default`: `{ engineId }` selects the default, initially `local-fast`.
- `POST /ocr/servers`, `PUT /ocr/servers/:id`, `DELETE /ocr/servers/:id`: server model CRUD.
- `POST /ocr/engines/:id/install`, `DELETE /ocr/install`: start/cancel explicit setup.
- `POST /ocr/engines/:id/test`: recognize only the bundled sample; return success,
  never provider output. A server model test transmits this sample to that endpoint.

Custom model input is `{ kind, authentication, label, endpoint, model, languages: string[] | null, apiKey? }`.
`kind` is one of the three API types above. `authentication` is `api-key` or `none`;
`none` is allowed only for localhost, 127.0.0.1 or ::1 endpoints. It stores a null
key reference and sends no Authorization header. Selecting `none` while editing
also deletes the previously saved key. A configured but missing key always fails;
it never silently switches to unauthenticated access. Old clients may omit the two
new fields: existing choices are preserved, with Chat Completions and API-key
authentication as the defaults for new entries.
Keys are encrypted with AES-256-GCM in a mode-0600 vault using the host encryption
key or a dedicated mode-0600 local key file. Settings responses include only
`keyConfigured`, never the key or its reference. Omitting a key during an edit keeps
it; changing the endpoint origin requires a replacement key. Removing the selected
server model returns the default to `local-fast` and removes its saved credential.

Run settings, credential and HTTP authorization checks with:
`pnpm --filter legalwork-server exec bun test src/ocr/manager.test.ts src/ocr/routes.test.ts src/ocr/api-adapters.test.ts`.
