# Isolated OCR desktop development

Run `pnpm dev:electron:ocr` from the OCR worktree. This opens **LegalWork OCR Dev** on frontend port **5177** with its own app identity, Electron profile, server database, engine history, project storage and orchestrator state. The default root is `~/.legalwork/ocr-gateway-dev`; set `LEGALWORK_OCR_DEV_ROOT` to use another empty directory.

Create test projects inside this instance's `projects` directory. Do not copy another dev profile or register its project folders: generated `.opencode` settings belong to the server that owns the project. The launcher rejects persisted project paths outside its project directory, including symlinks, and refuses an occupied frontend port.

Configure OCR in **Settings > AI Providers > OCR** against the dev Gateway tools endpoint. The isolated native OCR Gateway uses `http://127.0.0.1:8093/mcp-rest/tools/call`; its worker listens on port 5297. It has a private PostgreSQL process on port 5444, an `ocr_dev` database user, a `litellm_ocr_dev` database, master key and encryption key. It loads no chat models and excludes OCR payloads from request logs. Start it with `pnpm gateway:native` in the isolated model-api worktree's `gateway/ocr-mcp` directory. Configure chat separately. Do not copy another instance's account refresh tokens. The launcher does not restart shared Docker services or other LegalWork apps. External Office add-ins are disabled for this instance.

The native Gateway needs PostgreSQL's `initdb` and `pg_ctl` on PATH and a private Python 3.12 environment at `~/.legalwork/ocr-gateway-dev/native-gateway/.venv` with `litellm[proxy,extra_proxy]==1.106.6` installed. Create it with `uv --no-config venv --python 3.12 <path>` and install with `uv --no-config pip install --python <path>/bin/python 'litellm[proxy,extra_proxy]==1.106.6'`. Its private `~/.config/eigenwelt-ocr-dev/gateway.json` supplies `databaseURL` (`postgresql://ocr_dev:<password>@127.0.0.1:5444/litellm_ocr_dev`), `masterKey` and `saltKey`; never put these in the repository. The launcher creates its private PostgreSQL cluster and initializes its empty schema once, then disables automatic schema migrations. First run `node setup-dev.mjs --config-only`, then `node setup-memory-dev.mjs` and start the memory-only worker with `OCR_MEMORY_CONFIG="$HOME/.config/eigenwelt-ocr-dev/memory.json" pnpm start`. Run `node setup-dev.mjs` once the native Gateway is ready to register the OCR worker and create its restricted dev key. Pricing's Docker containers keep running.

Verify coexistence with both desktop apps running: check each server's project status, run a synthetic agent write/read in OCR, run its OCR provider test, and confirm the other instance's project configuration digests remain unchanged. Repeat after restarting OCR.

The OCR worker uses only a bounded RAM queue and returns each result directly.
It does not persist page images, results, jobs or fingerprints, and it has no
status/result-cache route. Request and response payload logging is disabled.
GPU inference uses read-only containers, RAM-backed temporary directories and
no cross-request prefix or multimodal processor cache. Parallel pages and vLLM
continuous batching remain enabled. Restarted/interrupted requests are retried
from the client; they cannot resume a stored server job. Source documents and
local chat history follow LegalWork's normal client storage policy. The Mac's
encrypted OS swap is an operating-system control outside application-level ZDR.
