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

Verify Mistral `none/high`, GLM `low/high/max`, and Provider default in the real
composer. Inspect requests to confirm Provider default omits the effort override.
Turn online catalog updates off in the disposable profile's Privacy settings and
verify paid models and explicit controls still work. Restore the switch afterward.

The October 7, 2026 run used Electron 43.7.5, OpenCode 1.18.29, the embedded
LegalWork server, Next.js 16.2.10 and a local LiteLLM 1.91.1 gateway. Existing regional
provider credentials were read in memory. Gemini used the existing paid gateway's
Google service identity because local application-default credentials had expired.
The local paid-account fixture does not test the production OAuth sign-in exchange.
Prompts and file contents were synthetic; production configuration was unchanged.

Results: the complete 15-model matrix passed 113 checks in the actual Electron
setup with a synthetic upstream, as well as 113 checks in the isolated engine.
Live providers passed 65 distinct checks: all choices and read tools on nine
routes, plus the two default checks on EU GPT Luna. OpenRouter then returned
HTTP 402, "Insufficient credits," leaving 48 live checks incomplete on the
remaining six routes. Both its EU and US endpoints returned the credit error.
The seven routes using other providers passed all 47 checks while online catalog
updates were disabled. Actual composer requests also verified Mistral `high/none`,
GLM `max`, and GLM Provider default with no effort override. The hosted catalog
was fetched successfully through the Next.js dev server after restoring updates.

Screenshots from the actual Electron app:

![Mistral high response and controls](model-reasoning-electron-mistral.jpg)

![GLM max response and controls](model-reasoning-electron-glm.jpg)
