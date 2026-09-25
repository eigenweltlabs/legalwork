# Developing SystemOne and OCR with project workspaces

## Matching repositories

This branch combines project/Akte workspaces with SystemOne, multi-model providers,
OCR preparation and Tabular Review. Managed EigenJev requires the matching backend:

- **LegalWork:** `codex/projects-akte-workspace` (includes `feat/systemone` through `cf4a304b`).
- **model-api:** [`feat/systemone`](https://github.com/eigenweltlabs/model-api/tree/feat/systemone),
  implementation `a14239e`, development guide `31177df`.

Use model-api commit `31177df` or a descendant containing that implementation.
The old platform does not provide the new managed SystemOne subscription contract.

The complete, checked-in setup is in the model-api
[real JEV development guide](https://github.com/eigenweltlabs/model-api/blob/31177df/gateway/dev/README.md).
It covers prerequisites, credentials, local provisioning, gateway settings, startup,
verification, expired keys and the separate production rollout.

## Local topology

```text
LegalWork → local platform subscription checks
          → local paid LiteLLM gateway (existing subscription key)
          → local development proxy :5295
          → deployed paid Cloud Run gateway → real OpenJev GPU pool
```

Keep production credentials in a private file outside either repository. LegalWork
receives only the local subscription key. The proxy accepts only SystemOne traffic;
chat providers and OCR engines retain their own configuration.

## Startup checklist

1. Check out model-api `feat/systemone`, install dependencies, and configure the
   existing Clerk desktop OAuth and Stripe **test** subscription flow from its
   `SETUP.md`. Use local platform and LiteLLM databases/admin URLs.
2. Obtain a restricted, short-lived paid-gateway virtual key with access to
   `EigenJev` and `jev-latest`, low request/token limits and a small budget.
   With the new guard it belongs to a development subscription team, never an
   `_api` team. Do not use the master key for inference.
3. In a mode-0600 file outside the repository, configure the proxy with
   `baseURL=https://ewl-paid-gateway-ygkjgxw23a-ey.a.run.app`, that restricted
   `apiKey`, a random local `proxyKey`, and `upstreamModel=jev-latest`.
   This is the paid service used in September 2026; confirm if deployment changes.
   Start it from model-api:

   ```sh
   SYSTEMONE_DEV_CONFIG="$HOME/.config/eigenwelt-systemone-dev/upstream.json" \
     node gateway/dev/systemone-proxy.mjs
   ```

4. In model-api `gateway/.env`, set `VLLM_API_BASE=http://host.docker.internal:5295`,
   `VLLM_API_KEY` equal to the private `proxyKey`, and
   `EIGENWELT_SYSTEMONE_GATEWAY=subscription`. This host URL assumes Docker Desktop
   on macOS. Use the patched `Dockerfile.paid` / LiteLLM 1.91.1; do not add JEV aliases
   as chat/router models. Preserve existing local master/salt keys and data volumes.
5. In model-api `apps/platform/.env.local`, set:

   ```dotenv
   DATABASE_URL=postgresql://litellm:litellm@localhost:5433/platform
   LITELLM_BASE_URL=http://localhost:8080
   LITELLM_MASTER_KEY=<local gateway master key>
   PUBLIC_GATEWAY_URL=http://localhost:8080/v1
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   EIGENJEV_SYSTEMONE_ENABLED=true
   EIGENJEV_DEPLOYMENT_REVISION=
   ```

   `EIGENJEV_BASE_URL` controls standalone API access, not this subscription path.
   Leave the local revision blank unless the real serving revision is known.
6. Run `pnpm dev:local` in model-api. It builds the local gateway, starts its
   databases, applies the platform schema and starts Next.js. After changing gateway
   env, recreate `litellm nginx`; after platform env changes, restart Next.js.
   Local Compose already contains Redis; this does not require new production Redis.
7. Start this LegalWork checkout with an isolated profile:

   ```sh
   pnpm install --frozen-lockfile
   EIGENWELT_PLATFORM_URL=http://localhost:3000 \
   LEGALWORK_ELECTRON_USERDATA="$HOME/.legalwork/systemone-dev/electron" \
   LEGALWORK_DATA_DIR="$HOME/.legalwork/systemone-dev" \
   LEGALWORK_WORD_ADDIN=0 PORT=5173 \
     pnpm --filter @legalwork/desktop dev
   ```

   Do not skip shared preparation on a fresh checkout. Sign in through Account to
   the local platform. Use a local firm with an active/trial test subscription;
   enable Europe and EigenJev Europe on its platform Models page.
8. In AI Providers → SystemOne → Eigenwelt → EigenJev Europe, use the three-dot
   menu's **Test connection**. Verify a successful real upstream response in the
   proxy metadata log, with serving model and token usage. Gateway health alone
   does not verify inference. There is no synthetic fallback.

Before the alias rollout, the production pool accepts `jev-latest` and returns
`openjev-0.1`; the proxy explicitly maps the local `EigenJev` request alias to it.
After rollout, use `upstreamModel=EigenJev`. The UI remains **EigenJev Europe** and
local metering charges **€0.05 per billion input tokens**, with free output.
The earlier temporary development credential expires October 1, 2026; it must be
rotated rather than copied as a permanent shared credential.

For existing custom dev ports, update `LITELLM_BASE_URL` and `PUBLIC_GATEWAY_URL`
together (the original setup used `http://localhost:4004` and `/v1` respectively).
Do not start a second stack on occupied ports or delete another development stack.

## Review and OCR

Open a project's **Tabular Review** page and choose the execution mode/models in
Review settings. Agents first call `legalwork_review_settings`, then reuse library
prompts with `legalwork_review_library`, create a saved review and start it. The
server enforces the selected mode and retains the same results for UI and agent use.

For PDF/image review, install a local OCR model or configure an OCR endpoint in AI
Providers. The review runner uses `DocumentPreparation`, which pins that engine.
DOCX/text are read completely with explicit size limits. SystemOne decisions remain
uncited; LLM citations are verified against source evidence. Incomplete OCR blocks
JEV and cannot become a clean LLM "Not found" result.

Review cells share a local worker queue across all projects, reviews and backends.
On machines with at least 16 GiB RAM, up to 16 cells and 4 prepared documents
are active; smaller laptops use 8 cells and 2 prepared documents. JEV-only,
LLM-only and mixed reviews can each use the whole cell pool. There is no separate
2-JEV/4-LLM partition or limit on the number of submitted reviews. Queues rotate
between reviews. OCR remains serialized to protect local model memory.

The server accepts these startup environment overrides (1–32):

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEGALWORK_REVIEW_CELL_CONCURRENCY` | 16 (8 below 16 GiB RAM) | Total active cells across backends and reviews |
| `LEGALWORK_REVIEW_DOCUMENT_CONCURRENCY` | 4 (2 below 16 GiB RAM) | Documents held for preparation and inference |

The development proxy adds no concurrency cap, and a development key does not
need a special parallel-request cap. The app owns local scheduling. Upstream
rate limits and transient outages use up to three attempts with exponential
backoff, jitter and `Retry-After`; completed chunks are retained.
Authentication, billing and invalid model answers are not retried. No model
fallback overrides the user's selected mode. The gateway still enforces token
and subscription budgets.

The table shows queued and running cell counts. Stop removes queued jobs and
aborts active requests before saving the final state. Completed cells survive;
Resume runs unfinished cells. After an app/server restart, unfinished work is
marked interrupted and waits for an explicit Resume rather than silently
starting paid requests.

See [SystemOne contract](systemone.md) and [OCR documentation](../apps/server/src/ocr/README.md).
These steps are for local development. Pushing either branch does not deploy the
production pool or gateways; production enablement follows model-api's separate
rollout checklist.
