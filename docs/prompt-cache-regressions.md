# Prompt cache regression contract

Every Linux/macOS LegalWork CI run starts the shipped OpenCode version with the
production runtime builder and all plugins configured for an isolated local
profile. The app's real prompt request builder and SDK send through the real
LegalWork server proxy. Only the model transport, UI snapshot and MCP service
are fixtures; no paid model or personal account is used.

The driver executes file reads, real MCP discovery/calls, skill discovery/loading,
delegation to an actual child agent and the scheduling clock. It changes the
sidebar during a tool call, then the project preferences, Word connection and app
context on a follow-up. It restarts the engine with the same SQLite history.
Every request within each agent's conversation must preserve ordered system
instructions, tool definitions and **all** previous messages, including saved
reminders, assistant tool calls/IDs and tool results. Only the history tail grows.
Diagnostics identify the agent/request and first changed field, without printing
the prompt. There are no timestamp scrubs, sorted tools or golden prompt snapshots.

The trajectory also fails a direct tool, corrects its arguments, catches a nested
Code Mode failure and then succeeds with typed output. Recovery guidance must be
saved with its error or owning outer result before the first request containing
it. Progress, later failures, idle, user turns and restart cannot remove or
recalculate an earlier hint. Unit tests separately check duplicate notifications,
outer-call ownership and that the retry limit starts only after a saved warning
is present in a model-facing context. Native errors can expose an underlying
cause instead of the outer message; the engine trajectory checks the actual
saved/serialized result rather than only a hook's mutable object.

A test-only engine process clock crosses midnight in Europe/Berlin between tool
steps in one user turn and stays on the new day across follow-ups and restart.
The initial date snapshot must stay unchanged; the
new date arrives as a chronological instruction update. This protects the native
engine's existing fix for the old 1.18.29 live system-date behavior. The fixture
also disconnects and reconnects its Code Mode MCP server without rebasing the
prefix, covering availability changes independently of a settings edit.

Explicit compaction and model selection changes start named cache epochs, each
with a follow-up checked against its new baseline. Ordinary turns, state updates
and restarts never reset the baseline. A permission/tool-set change likewise
requires a declared boundary in any future scenario; the guard rejects it by
default. A second real-engine run adds a plugin injecting a changing system
timestamp and verifies that this regression is detected. Unit mutation controls
also cover tool order, historical text, call IDs, truncation and model changes.

The independent Model API CI job runs this same agent **live through nginx and
the paid LiteLLM image**, with Vertex authentication and the final HTTP provider
endpoint replaced. Scripted Gemini tool calls travel back through the adapter to
the real engine. The provider boundary checks actual serialized system instructions,
tool declarations and ordered content parts, plus provider route stability.
Compaction/model epochs are the only accepted reset sequence. Its mutation
controls cover the provider's system text, tool order and completed history.
Docker's internal network prevents external provider requests. The combined job
reports both repository SHAs and pins its public LegalWork checkout; update that
pin alongside engine/request-builder changes. Private Model API is not checked
out using a token in public LegalWork PR jobs.

These checks prove cache eligibility, not a provider cache hit. A live-provider
release smoke can separately measure `prompt_tokens_details.cached_tokens` after
warming a long, stable prefix; provider TTL/minimum size and availability affect
that result. LiteLLM's response-cache `cache_hit` is a different metric and is
never used by this gate.

The driver uses the local runtime without a VM so it runs independently of
sandbox integration jobs. Existing VM/permission tests keep their own coverage.
This gate exercises configured runtime plugins; it does not exercise every
possible account entitlement, custom plugin, multimodal payload or provider.

## Run locally

```sh
pnpm --filter legalwork-server build
LEGALWORK_TEST_OPENCODE_BIN=/absolute/path/to/shipped/opencode \
LEGALWORK_CACHE_CAPTURE=/tmp/prompt-cache-capture.json \
bun test --preload ./apps/server/test-preload.ts apps/server/scripts/prompt-cache-engine.test.ts
bun test --preload ./apps/server/test-preload.ts apps/server/src/prompt-cache.test.ts
```

In Model API, after building the LegalWork server and installing its dependencies:

```sh
python3 scripts/test-agent-prompt-cache.py \
  --legalwork /absolute/path/to/legalwork \
  --opencode-bin /absolute/path/to/shipped/opencode
```

This builds the repository's real paid and nginx images. `--local-proxy` runs the
same live agent/Vertex adapter check without nginx, using Python with the exact
LiteLLM version from `gateway/Dockerfile.paid`. Passing a capture JSON instead of
`--legalwork` replays saved synthetic requests for gateway debugging.
