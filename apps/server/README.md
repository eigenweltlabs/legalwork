# LegalWork Server

Filesystem-backed API for LegalWork remote clients. This package provides the LegalWork server layer described in `apps/app/pr/legalwork-server.md` and is intentionally independent from the desktop app.

## Quick start

```bash
npm install -g legalwork-server
legalwork-server --workspace /path/to/workspace --approval auto
```

`legalwork-server` ships as a compiled binary, so Bun is not required at runtime.

Or from source with Bun 1.4.2+ (older runtimes can truncate FTPS transfers):

```bash
pnpm --filter legalwork-server dev -- \
  --workspace /path/to/workspace \
  --approval auto
```

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

Token management (scoped tokens):

- `LEGALWORK_TOKEN_STORE` path to token store JSON (default: alongside `server.json`)

File injection / artifacts:

- `LEGALWORK_INBOX_ENABLED` (`1` | `0`)
- `LEGALWORK_INBOX_MAX_BYTES` (default: 50MB, capped)
- `LEGALWORK_OUTBOX_ENABLED` (`1` | `0`)

Sandbox advertisement (for capability discovery):

- `LEGALWORK_SANDBOX_ENABLED` (`1` | `0`)
- `LEGALWORK_SANDBOX_BACKEND` (`docker` | `container` | `none`)

## Endpoints

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

Token management (host/owner auth):

- `GET /tokens`
- `POST /tokens` (body: `{ "scope": "owner"|"collaborator"|"viewer", "label"?: string }`)
- `DELETE /tokens/:id`

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

OpenCode Router proxy:

- `GET|POST|... /opencode-router/*`
- `GET|POST|... /w/:id/opencode-router/*`

Auth policy:
- `GET /opencode-router/health` requires client auth.
- All other `/opencode-router/*` endpoints require host/owner auth.

## Approvals

All writes are gated by host approval.

Host APIs accept either:

- `X-LegalWork-Host-Token: <token>` (legacy host token), or
- `Authorization: Bearer <token>` where the token scope is `owner`.

Approvals endpoints:

- `GET /approvals`
- `POST /approvals/:id` with `{ "reply": "allow" | "deny" }`

Set `LEGALWORK_APPROVAL_MODE=auto` to auto-approve during local development.
