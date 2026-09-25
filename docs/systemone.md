# SystemOne

SystemOne is a separate typed-question API, not a chat provider. Settings → AI
lists the managed EigenJev model and lets users configure JEV-compatible providers.
Tabular Review consumes this contract through agent tools; document search and OCR remain separate.

## Subscription and providers

EigenJev uses the **existing subscription gateway key** saved at sign-in. No API
key creation or additional credential is required. A firm admin enables EigenJev
under SystemOne on the platform Models page. It requires an active/trial subscription,
EU region permission, and a ready platform deployment. Before every managed request,
the server checks `/api/desktop/systemone`; an outage never grants access. Sign-out,
disabled access and removed membership prevent execution. Platform model choices
control both the `EigenJev` and legacy `jev-latest` gateway aliases together.

EigenJev Europe costs **€0.05 per billion input tokens; output tokens are free**.
Usage consumes the existing subscription allowance through that same key.
The gateway retains fractional-cent spend and the platform rounds cumulative
spend, so small requests are not individually rounded up or discarded.

A provider is one connection (name, endpoint, API key, enablement), serving many models.
Models belong to its `models[]` collection and carry their own ID, display name,
description, release date and question types. The Eigenwelt provider currently serves
**EigenJev Europe** through the existing subscription key.

Following [TypeSafe's original model API](https://docs.typesafe.ai/models), LegalWork
fetches authenticated `GET /v1/models` next to `POST /v1/systemone`. It parses the
native `{models: [{name, description, release_date}]}` response; `name` is the request
model ID. All models share the provider connection. The TypeSafe preset uses
`https://api.typesafe.ai/v1/systemone`; it discovers aliases rather than hard-coding
one model into the connection. The API does not advertise question types per model;
the standard SystemOne question types apply to discovered models.

Optional configured model IDs supplement discovery for pinned versions (which TypeSafe
accepts even when absent from its catalog), self-hosted providers or custom endpoints
without the listing route. Settings distinguish `source: "discovered" | "configured"`.
If discovery fails, the response includes `modelsError`; only explicit configured IDs
remain, with no invented catalog or fallback. Authentication failures mark the provider
disconnected. The catalog is loaded on settings/discovery reads and rechecked on custom
execution. A removed discovered model cannot silently run another alias.

Existing one-model records are migrated on read to configured model entries, retaining
provider IDs, endpoints, keys, capabilities and the saved selection. The next settings
write persists the new shape. Separate saved connections are not merged automatically.

Settings are shared by workspaces on a LegalWork server. Custom credentials are
stored server-side in `systemone.json` alongside runtime state, with mode `0600`,
atomic replacement and serialized writes. They never appear in settings responses.
A blank key preserves the stored key; changing the endpoint requires a new key.
Removing or disabling a selected provider does **not** switch to another provider.

## Tool-building contract

The app's `createLegalworkServerClient` exposes:

```ts
const result = await legalwork.systemOne({
  state: { item: "The item is red." },
  questions: {
    red: { type: "noul", instructions: "Is the item red?" },
    color: {
      type: "choice", instructions: "Which color is the item?",
      criteria: { red: null, blue: null },
    },
    rating: {
      type: "score", instructions: "How red is the item?",
      criteria: ["Not red", "Red"],
    },
  },
}, { signal: abortController.signal });

result.answers.red.noul;         // number, typed by question ID
result.answers.color.choice;    // string
result.answers.rating.score;    // number, may lie between rubric levels
result.requestedModel;          // EigenJev (configured alias)
result.model;                   // actual upstream serving model/version
result.deployment_revision;     // optional build identifier
```

`providerId` in options explicitly overrides the saved selection. `model` in the
request selects a discovered or explicitly configured model within that provider. When
choosing a different provider, pass its model explicitly. Otherwise the saved
`{providerId, model}` selection applies. There is no provider or model fallback.
The server package also exports `systemOne(config, request, options)` and the shared
schemas/types (`@legalwork/types/systemone`). Names follow the upstream
[JavaScript SDK](https://docs.typesafe.ai): the operation is `systemOne`, not `evaluate`.

State and instructions accept strings, JSON objects or arrays. Questions are keyed
by caller-provided IDs: `noul` returns a yes probability; `choice` returns a selected
option and distribution; `score` returns a weighted value over 2–10 ordered levels,
a legend and distribution. Answers must exactly match question IDs/types and choice
or score probability keys. Invalid results fail without invented or repaired answers.
Confidence and token usage are preserved when supplied by the provider.

## HTTP surface

All routes use existing LegalWork server bearer authentication. Viewing settings
requires viewer access; execution/testing and changes require collaborator access.
Configuration changes also require a writable server.

| Method | Route | Body/result |
| --- | --- | --- |
| GET | `/systemone/settings` | Redacted providers and saved selection |
| PUT | `/systemone/providers` | `{id, name, endpoint, enabled, models: [{id, name, questionTypes}], apiKey?}`; `models` contains explicit pins, not the discovered catalog |
| DELETE | `/systemone/providers/:providerId` | Remove a custom provider |
| PUT | `/systemone/selection` | `{ providerId, model }` |
| POST | `/systemone/test` | `{ providerId, model }`; synthetic questions only |
| POST | `/systemone` | `{ request: { state, questions, model? }, providerId? }` |

Execution returns the JEV response plus `providerId` and `requestedModel`.
Errors use existing `{ code, message }` responses: 400 invalid request, 401 invalid
provider credential, 403 denied access, 409 unavailable selection, 422 unsupported
capability/model/input, 429 rate limit, 499 cancelled, 502 invalid provider response,
503 provider unavailable and 504 timeout. Upstream error bodies are never exposed.

Calls have a 120-second total transport deadline. Rate limits, overloads and transient
HTTP gateway failures retry up to three attempts with backoff and bounded Retry-After;
authentication/validation failures do not retry. Redirects are rejected to protect keys.
No hard-coded TypeSafe context/rate limits are assumed for EigenJev or custom models.

## Validation and rollout

For the matching model-api branch and real-gateway local setup, see
[SystemOne development](systemone-dev.md).

Run `pnpm --filter legalwork-server exec bun test src/systemone-client.test.ts src/systemone.e2e.test.ts`,
server/app typechecks and `pnpm --filter @legalwork/app test:i18n`.
The development-only `settings-preview.html?tab=ai` fixture uses local in-memory data.

Deploy the matching model-api change and the patched OpenJev pool before enabling
`EIGENJEV_SYSTEMONE_ENABLED=true`. The backend accepts EigenJev while retaining
jev-latest. See model-api's `infra/openjev/README.md` for rollout and rollback order.
Older platform versions leave managed EigenJev unavailable; existing chat remains usable.

The managed model is displayed as **EigenJev Europe**. Request identifiers remain `EigenJev` and the compatibility alias `jev-latest`; changing the display name does not change stored selections or subscription permissions. Custom provider setup assumes the standard SystemOne question types and verifies them through Test connection; users do not configure those capabilities in the form.

## Tabular Review

The bundled `tabular-review` skill calls `tabular_review_models` to discover connected
chat models and ready SystemOne provider/model pairs. Discovery returns only public model IDs,
names and capabilities, with per-backend errors if discovery fails. It does not expose
keys or provider endpoints. Selection is per call, not a change to the user's default.

`tabular_review_row` accepts `backend: "llm" | "systemone"`, `providerId`, `model`,
`file`, `title`, `docType`, and either a `preparationPath` for PDF/images or full
source `pages: [{page: number | null, text}]` for DOCX/text, plus
`columns: [{key, label, question, hint?, decision?}]`. SystemOne requires `decision`
using the existing typed question schema for every column. Free-text/cited review
uses LLM. The agent first prepares PDF/images with `legalwork_document_prepare`,
which pins the selected OCR engine for the run. The review tool verifies the source
hash and workspace paths, then loads native/OCR text and regions without discarding
page identity. DOCX/text keep their existing readers. No truncation or model fallback
occurs. Incomplete or uncertain OCR blocks SystemOne inference; LLMs can return cited
findings but cannot turn uncertain extraction into a clean "Not found" result.

LLM review runs in an isolated child session with tools disabled and validates exact
column IDs and verbatim citations against the supplied page text, including OCR
source/region references and multiple citations. The artifact builder resolves
coordinates from the prepared evidence and preserves uncited SystemOne decisions. This validates
citation occurrence, not the legal correctness of an answer. SystemOne uses the same
server relay and subscription key as other calls. Availability and capabilities are
rechecked before inference. Explicit failures remain errors, never synthetic answers.

Results are `{ok:true,row}` with artifact-compatible cells and `review` provenance
(backend, provider, requested and actual model; SystemOne usage/revision when supplied).
SystemOne preserves raw distributions and scores, labels cells as uncited decisions,
and leaves extraction confidence/citations empty. It never fabricates source evidence.
`{ok:false,error}` must be retained as a visible error row by the orchestrator.
