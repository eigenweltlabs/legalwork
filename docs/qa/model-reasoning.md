# Reasoning verification

The reasoning smoke test exercises the pinned OpenCode engine, rather than
mocking LegalWork's configuration builder. The fixture contains every Eigenwelt
EU/US route exported by the model API. It checks discovery, every enabled variant,
provider and engine defaults, unsupported saved choices, streaming, and a completed
read-tool round trip on every model. It verifies the effort on both sides of each
tool call. These checks establish protocol compatibility, not reasoning quality.

For an isolated engine with synthetic responses:

```sh
OPENCODE_BIN=/path/to/pinned/opencode pnpm --filter legalwork-server test:reasoning
```

Supply `MODEL_API_TEST_BASE_URL` and `MODEL_API_TEST_KEY` through the environment
to use a live gateway instead. Do not put credentials in command arguments or
commit them.

## Actual Electron and model API development servers

Use a disposable Electron profile, workspace, runtime database and paid-account
fixture. Run the normal `pnpm dev:electron` command and the model API's Next.js dev
server. Point `OPENCODE_MODELS_URL` at the dev server's
`/api/public/model-catalog` base URL and `EIGENWELT_PLATFORM_URL` at that server.
The paid manifest must come from its actual `/api/public/models` response.

Place a loopback recorder between the manifest's gateway URL and a local gateway
configured with the real regional providers. Record only this JSON array shape:

```json
[{"model":"Eigenwelt Europe Mistral","effort":"high","stream":true,"nonce":"MODEL_REASONING_CHECK_...","status":200}]
```

Extract `nonce` from the latest user message beginning with `MODEL_REASONING_`.
Exclude OpenCode's separate title-generator requests. Use `null` for an absent
effort. Never record authorization headers, full requests, prompts or tool outputs.

Run the same matrix against Electron's existing managed engine through its
authenticated LegalWork server proxy:

```sh
MODEL_REASONING_ENGINE_URL=http://127.0.0.1:PORT/workspace/WORKSPACE_ID/opencode \
MODEL_REASONING_WORKSPACE=/path/to/disposable/workspace \
MODEL_REASONING_CAPTURE_REPORT=/path/to/requests.json \
MODEL_REASONING_REPORT=/path/to/results.json \
bun apps/server/scripts/reasoning-smoke.ts /path/to/dev-manifest-models.json
```

Provide the disposable server's bearer token as `MODEL_REASONING_ENGINE_KEY`
through the environment. Leave the Electron window idle while the matrix runs;
test normal composer interactions separately.

Verify Mistral `none/high` and GLM `low/high/max` in the real composer. The
Mistral dropdown must start with `high` selected and contain exactly two entries;
GLM must start with `max` selected and contain exactly three entries. There is no
additional Provider default entry. An unset variant uses the model's standard
`options.reasoningEffort`; that effort is sent explicitly. Select a different
effort and then return to the original choice, checking the recorded requests.
Turn online catalog updates off in the disposable profile's Privacy settings and
verify paid models and explicit controls still work. Restore the switch afterward.

The October 7, 2026 run used Electron 43.7.5, OpenCode 1.18.29, the embedded
LegalWork server, Next.js 16.2.10 and a local LiteLLM 1.91.1 gateway. Existing regional
provider credentials were read in memory. Gemini used the existing paid gateway's
Google service identity because local application-default credentials had expired.
The local paid-account fixture does not test the production OAuth sign-in exchange.
Prompts and file contents were synthetic; production configuration was unchanged.

The latest native-default update passed the complete 15-model matrix: 113
checks in the actual Electron setup with a synthetic upstream, and 113 checks
in the isolated engine. Each model also verifies that the dropdown marks its
configured native default, contains no extra default item, and keeps the variant
override unset until an explicit choice. All matrix requests are checked for the
expected effort, streaming and HTTP 200, including both read-tool rounds.
The normal Electron composer separately sent GLM `max`, then `low`, then `max`
after returning to its original choice; all three synthetic requests streamed
and returned HTTP 200. Fresh-launch screenshots verify Mistral `high` and GLM
`max` with no additional default entry.

Live verification of this update passed 33 checks across five complete routes:
EU DeepSeek, Gemini, GLM and Mistral, plus US Gemini. OpenRouter EU and US still
return HTTP 402, "Insufficient credits." Fireworks returned HTTP 401,
"Unauthorized," for US DeepSeek and US GLM; separate synthetic requests to the
production paid gateway reproduced both errors. This prevents completing the
live matrix on the other ten routes. Credentials and production configuration
were not changed. These upstream failures are separate from synthetic protocol
verification; do not claim that all routes passed live.

Before the default-display update, live verification passed 65 distinct checks,
including nine complete routes, and the seven non-OpenRouter routes passed with
online catalog updates disabled. The hosted public catalog was fetched through
the Next.js dev server after restoring the disposable profile's Privacy switch.
The new default values are published in the paid manifest's standard OpenCode
options, independently of public catalog updates.

Screenshots from the actual Electron app:

![Mistral native default and its two choices](model-reasoning-electron-mistral.jpg)

![GLM native default and its three choices](model-reasoning-electron-glm.jpg)
