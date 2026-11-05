# LegalWork Server

Filesystem-backed API for LegalWork remote clients. This package provides the LegalWork server layer described in `apps/app/pr/legalwork-server.md` and is intentionally independent from the desktop app.

## Quick start

```bash
npm install -g legalwork-server
legalwork-server --workspace /path/to/workspace --approval auto
```

`legalwork-server` ships as a compiled binary, so Bun is not required at runtime.

For a persistent personal assistant VM, see [Personal assistant cloud sync](../../docs/cloud-assistant-sync.md).

For development, use the Node.js version in `.nvmrc` (or an updated Node.js
22 release, at least 22.15) and the repository's existing pnpm/Bun build tools:

```bash
pnpm --filter legalwork-server dev -- \
  --workspace /path/to/workspace \
  --approval auto
```

This builds the server's JavaScript and runs it with your existing Node.js.
After building, `pnpm --filter legalwork-server start -- ...` starts the same
server without rebuilding. Bun remains a build and test tool; this does not
install or bundle another runtime, and Electron still runs its embedded server.

The server logs the client token and host token on boot when they are auto-generated.

Add `--verbose` to print resolved config details on startup. Use `--version` to print the server version and exit.

## Config file

Defaults to `~/.config/legalwork/server.json` (override with `LEGALWORK_SERVER_CONFIG` or `--config`).

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "approval": { "mode": "manual", "timeoutMs": 30000 },
  "workspaces": [
    {
      "path": "/Users/susan/Finance",
      "name": "Finance",
      "workspaceType": "local",
      "baseUrl": "http://127.0.0.1:4096",
      "directory": "/Users/susan/Finance"
    }
  ],
  "corsOrigins": ["http://localhost:5173"]
}
```

## Environment variables

- `LEGALWORK_SERVER_CONFIG` path to config JSON
- `LEGALWORK_HOST` / `LEGALWORK_PORT`
- `LEGALWORK_TOKEN` client bearer token
- `LEGALWORK_HOST_TOKEN` host approval token
- `LEGALWORK_APPROVAL_MODE` (`manual` | `auto`)
- `LEGALWORK_APPROVAL_TIMEOUT_MS`
- `LEGALWORK_WORKSPACES` (JSON array or comma-separated list of paths)
- `LEGALWORK_CORS_ORIGINS` (comma-separated list or `*`)
- `LEGALWORK_OPENCODE_BASE_URL`
- `LEGALWORK_OPENCODE_DIRECTORY`
- `LEGALWORK_OPENCODE_USERNAME`
- `LEGALWORK_OPENCODE_PASSWORD`

File injection / artifacts:

- `LEGALWORK_INBOX_ENABLED` (`1` | `0`)
- `LEGALWORK_INBOX_MAX_BYTES` (default: 50MB, capped)
- `LEGALWORK_OUTBOX_ENABLED` (`1` | `0`)

Sandbox advertisement (for capability discovery):

- `LEGALWORK_SANDBOX_ENABLED` (`1` | `0`)
- `LEGALWORK_SANDBOX_BACKEND` (`docker` | `container` | `none`)

## Endpoints

- `GET /recorder/recordings` (desktop owner: retained recording metadata; optional `scope=global`, `period=today|yesterday`, inclusive `from`/`to`, `timeZone`, title `query`, `projectId`, `limit`, `cursor`; scheduled sessions are limited to configured projects plus global recordings)
- `GET /recorder/recordings/:id` (desktop owner: current transcript and speaker names; `offset`/`limit` pagination; chats can read global/current-project recordings, other projects require existing access or approval; scheduled sessions cannot expand their saved project scope)
- `GET /health`
- `GET /status`
- `GET /capabilities`
- `GET /whoami`
- `GET /workspaces`
- `GET /workspace/:id/config`
- `PATCH /workspace/:id/config`
- `GET /workspace/:id/events`
- `POST /workspace/:id/engine/reload`
- `GET /workspace/:id/plugins`
- `POST /workspace/:id/plugins`
- `DELETE /workspace/:id/plugins/:name`
- `GET /workspace/:id/skills`
- `POST /workspace/:id/skills`
- `GET /workspace/:id/mcp`
- `POST /workspace/:id/mcp`
- `DELETE /workspace/:id/mcp/:name`
- `GET /workspace/:id/commands`
- `POST /workspace/:id/commands`
- `DELETE /workspace/:id/commands/:name`
- `GET /workspace/:id/audit`
- `GET /workspace/:id/export`
- `POST /workspace/:id/import/preview`
- `POST /workspace/:id/import`

Workspace guest sharing has been removed. The `/tokens` endpoints return 404,
and persisted share tokens (including viewer and owner tokens) are no longer
accepted. The configured application bearer token and host header credential
remain available for the desktop and explicitly operated servers. Desktop
servers always bind to `127.0.0.1`; legacy remote-access settings are ignored.

Inbox/outbox:

- `POST /workspace/:id/inbox` (multipart upload into `.opencode/legalwork/inbox/`)
- `GET /workspace/:id/artifacts`
- `GET /workspace/:id/artifacts/:artifactId`
- `POST /workspace/:id/files/sessions`
- `POST /files/sessions/:sessionId/renew`
- `DELETE /files/sessions/:sessionId`
- `GET /files/sessions/:sessionId/catalog/snapshot`
- `GET /files/sessions/:sessionId/catalog/events`
- `POST /files/sessions/:sessionId/read-batch`
- `POST /files/sessions/:sessionId/write-batch`
- `POST /files/sessions/:sessionId/ops`

Toy UI (static assets served by the server):

- `GET /ui`
- `GET /w/:id/ui`
- `GET /ui/assets/*`

OpenCode proxy:

- `GET|POST|... /opencode/*`
- `GET|POST|... /w/:id/opencode/*`

## Approvals

Gated HTTP writes use the configured host approval mode. These approvals are separate from OpenCode's tool permission prompts.

Host APIs require `X-LegalWork-Host-Token: <token>`.
Bearer owner tokens have been retired.

Approvals endpoints:

- `GET /approvals`
- `POST /approvals/:id` with `{ "reply": "allow" | "deny" }`

The standalone server defaults to `manual`. The desktop defaults to `auto` for convenient local use, while preserving explicit `LEGALWORK_APPROVAL_MODE` and `server.json` `approval.mode` settings. Set either to `manual` to require host confirmation for gated writes, including requests from the desktop, agents, and remote clients. The desktop presents these requests in a native dialog; dismissing it, closing the host window, or reaching the approval timeout denies the request. The host API above remains available in either environment.

Precedence is explicit `--approval`, `LEGALWORK_APPROVAL_MODE`, `server.json` `approval.mode`, then the environment's default. `LEGALWORK_APPROVAL_TIMEOUT_MS` or `approval.timeoutMs` controls the wait (30 seconds by default). `auto` skips this additional confirmation; token authentication and scope checks still apply.

## Online model catalog updates

LegalWork fetches the public model registry from Eigenwelt at
`https://platform.eigenweltlabs.com/api/public/model-catalog/api.json`.
Catalog requests contain no prompts, documents, provider keys or provider
selection. They are ordinary HTTP requests, so Eigenwelt's infrastructure sees
the client IP and request metadata. The platform mirrors upstream metadata
without forwarding client details.

**Settings → Privacy → Update the model list online** is enabled by default.
Turning it off stops online catalog requests from the server and its managed
engine, including manual refreshes. The saved or bundled model list remains
available. This preference persists alongside `server.json` in
`model-catalog-settings.json`; the last successful registry is saved in
`model-catalog.json`. Invalid saved preferences disable online updates.

Authenticated clients can read/update `{ "onlineUpdatesEnabled": boolean }`
using `GET`/`PUT /model-catalog/settings`; updates require collaborator scope
and a writable server. `GET /model-catalog/api.json` serves only public model
metadata for orchestrator-managed engines. The desktop starts a dedicated
loopback catalog relay before its engine so the preference also applies during
startup. External engines started outside LegalWork must be configured by
their operator; the setting cannot control those processes.

Catalog redirects are rejected and failures never fall back to a third-party
URL. For development, `OPENCODE_MODELS_URL` may target a loopback server. Remote
catalog overrides must use `https://platform.eigenweltlabs.com`. The standalone
orchestrator-managed engine uses its LegalWork settings server. Operators of
external engines can disable catalog updates with `OPENCODE_DISABLE_MODELS_FETCH=1`.

Deploy the model-api mirror before releasing this client. The catalog switch
does not affect model inference, custom provider discovery, Eigenwelt billing
manifests, software updates or other user-selected services.
