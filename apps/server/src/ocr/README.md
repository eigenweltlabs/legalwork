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
- The quality and custom API adapters return page-level text and no regions.
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

Jobs/pages run sequentially within a service instance. Limits are 100 pages, 20 MiB
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

The installer reuses `uv` on PATH, or downloads a pinned official release into the
application's OCR directory and verifies its SHA-256 before execution. Bootstrap
assets cover macOS, Windows and glibc Linux on x64/ARM64. No global install or
administrator rights are needed. `LEGALWORK_OCR_UV_BIN` can explicitly override the
installer; an invalid override fails instead of downloading another installer.
Setup creates a managed Python 3.12 environment, installs pinned direct dependencies,
downloads pinned models and checks a built-in sample before reporting Ready.
Only Apple Silicon currently supports the higher-quality MLX runtime.

Cancelling small-model setup is remembered across restarts; Download model clears
that cancellation and retries. Failed setup retries on the next launch, or manually
from Settings. Closing the application cancels running setup without disabling the
next startup attempt. To disable automatic setup for a deployment, set
`LEGALWORK_OCR_AUTO_DOWNLOAD=0` or `"autoDownloadOcr": false` in the server config.
Read-only servers never start automatic downloads. Extraction itself never installs
models; callers still need to wait for the selected model to become ready.

`apps/server/resources/ocr/` is included in server package files and Electron's
external resources, so Python scripts remain outside ASAR. The manual setup below
is also available for embedding hosts with their own runtime lifecycle.

Example from `apps/server`, using Python 3.12 and `uv`:

```sh
uv venv --python 3.12 /application-data/ocr/venv
uv pip install --python /application-data/ocr/venv/bin/python -r resources/ocr/requirements-fast.txt
/application-data/ocr/venv/bin/python resources/ocr/prepare.py --model pp-ocrv6-small --model-dir /application-data/ocr/models
```

Use the equivalent `Scripts/python.exe` path on Windows. The fast adapter uses
ONNX Runtime CPU with four threads. This implementation was exercised on macOS
Apple Silicon; Windows/Linux packaging and hardware testing remain separate work.

For the optional quality engine on Apple Silicon:

```sh
uv pip install --python /application-data/ocr/venv/bin/python -r resources/ocr/requirements-quality.txt
/application-data/ocr/venv/bin/python resources/ocr/prepare.py --model paddleocr-vl-1.6 --model-dir /application-data/ocr/models
```

Setup pins detector/recognizer and VLM snapshot revisions. Model manifests reference
the Hugging Face cache, so that cache must remain installed. The VLM is the BF16
`matrixmaven/PaddleOCR-VL-1.6-bf16` MLX conversion used in the exploratory benchmark;
it currently requires Apple Silicon. Other platforms return an explicit runtime
error rather than silently changing the engine. The fast dictionary and unused-but-
constructed orientation classifier are provisioned explicitly too.

Workers use local model paths, offline Hugging Face/Transformers settings, and
validate required fast-model assets before constructing RapidOCR. Missing assets
fail rather than trigger installation. One worker is started per page, so measured
job latency includes model startup and will exceed warm benchmark timings. A future
persistent worker can implement the same engine interface without changing callers.

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

The tests cover explicit engine selection, no fallback, language and size validation,
coordinates, source identity, warnings, progress, queueing, deadlines, cancellation,
settings persistence, key isolation, bounded responses and the subprocess boundary.

An opt-in real-model smoke test uses the generated bilingual PNG fixture (a functional
test, not the handwriting benchmark). It downloads nothing:

```sh
LEGALWORK_OCR_SMOKE_PYTHON=/application-data/ocr/venv/bin/python LEGALWORK_OCR_SMOKE_MODELS=/application-data/ocr/models pnpm --filter legalwork-server exec bun test src/ocr/ocr.test.ts
```

On Apple Silicon the smoke test requires both models to have been prepared; on other
platforms it exercises the fast model.

## Tabular Review integration

`document-preparation/service.ts` is the shared consumer. The bundled review workflow
calls `legalwork_document_prepare` once with all PDF/image paths, polls
`legalwork_document_preparation_status`, and supplies the returned `preparationPath`
to each document extractor. The server pins the selected model, endpoint and credentials
for that run. DOCX/text continue through their existing readers.

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
