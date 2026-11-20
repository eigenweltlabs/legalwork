# Isolated OCR desktop development

Run `pnpm dev:electron:ocr` from the OCR worktree. This opens **LegalWork OCR Dev**
on frontend port **5177** with its own app identity, Electron profile, server
runtime, engine history, projects and orchestrator state. It does not restart
Docker or any other LegalWork instance. Office add-ins are disabled here.

For the managed Google trial, use the dedicated fresh root and synthetic platform:

```sh
LEGALWORK_OCR_DEV_ROOT="$HOME/.legalwork/ocr-google-dev" \
EIGENWELT_PLATFORM_URL=http://127.0.0.1:3017 pnpm dev:electron:ocr
```

Start the Google worker, native Gateway and synthetic platform using the sibling
model-api repository’s `infra/ocr/README.md`. They use worker **5298**, Gateway
**8093**, platform **3017**, Gateway PostgreSQL **5444** and platform PostgreSQL
**5445**. Pricing’s **8092/5443** services and JEV are separate. The private Python
environment pins LiteLLM **1.109.1**; only that environment is patched. Google
requires `gcloud auth application-default login` locally. The managed worker runs
with filesystem writes and child processes denied and makes synchronous regional
Document AI requests; it has no GPU, saved job or result cache.

With those services and Electron running, execute:

```sh
bun scripts/configure-ocr-google-dev.mjs
```

This imports only the fixture’s synthetic firm into `~/.legalwork/ocr-google-dev`,
tests **Google Document OCR (EU)** through the existing Gateway tool route and
selects it as the default. It refuses to overwrite another firm account. It does
not copy real account tokens or configure a chat model. In the app, open
**Settings > AI Providers > Document recognition providers (OCR)** to run
**Test sample** again or select another available recognizer.

Create a project in this instance and put synthetic documents inside its own
`projects` directory. Ask a connected agent to read a scanned PDF with OCR, or
exercise the same native read surface with authenticated
`POST /workspace/:id/pdf/read` and `{dataBase64, ocr:true, text:true}`. Text-only
reads never start OCR. A fresh image-only PDF avoids LegalWork’s local completed-
page cache when measuring cloud latency. Never use real customer material in
shared test evidence.

The synthetic platform uses real OCR policy/database services while substituting
local account/session setup. Its admin fixture route is loopback-only and is not
a production login flow. Integration tests exercise the real admin settings route
with a verified-session fixture. Production firm admins use **Models > region >
Cloud OCR** on their actual platform. When **All models** is on, first turn it off
before disabling an individual OCR model. Check both a stale direct Gateway call
and a new LegalWork page after disabling: no page should reach Google.

To inspect retained dev spend logs without printing contents, run
`node check-dev-retention.mjs` in model-api’s `gateway/ocr-mcp` directory. The
Gateway excludes OCR arguments, image bodies and recognized text from persisted
logs. Usage, latency and accounting metadata remain. Google’s online service
processes document content in memory; its operational metadata is retained.
Local source files and text returned to local chat follow LegalWork’s normal
storage policy.

The launcher rejects persisted project paths outside its own project directory,
including symlinks, and refuses an occupied frontend port. Do not import another
profile or another instance’s projects. The general default root remains
`~/.legalwork/ocr-gateway-dev`; the Google trial above intentionally uses a fresh
root. For a previously prepared worktree whose regenerated macOS sidecar hits a
local codesign error, verify/sign only that worktree’s generated sidecars, then
use `LEGALWORK_ELECTRON_SKIP_SHARED_PREPARE=1` to reuse them; the launcher still
builds the current server code and checks the reviewed engine resources.

Text-only evidence from the Google trial: an 11-page synthetic scan with no text
layer completed through the isolated Electron server and Gateway in **2,958 ms**,
with eight peak provider calls, all 11 markers correct, no page errors and zero
retained worker content bytes. Disabling OCR returned Gateway HTTP **403** and
LegalWork **disabled**; the synthetic firm was re-enabled afterward. This is one
local dev measurement, not a customer throughput guarantee.
