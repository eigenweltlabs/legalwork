# LegalWork Orchestrator

Host orchestrator for OpenCode and LegalWork server. This is a CLI-first way to run host mode without the desktop UI.

Published on npm as `legalwork-orchestrator` and installs the `legalwork` command.

The legacy Slack/Telegram messaging bridge has been removed. Old enable flags
are rejected, and messaging configuration cannot start a connector. Previously
generated bot tools and native messaging plugins are moved into
`retired-messaging-tools` on startup, preserving their contents and local edits.

## Quick start

```bash
npm install -g legalwork-orchestrator
legalwork start --workspace /path/to/workspace --approval auto
```

When run in a TTY, `legalwork` shows an interactive status dashboard with service health, ports, and
connection details. Use `legalwork serve` or `--no-tui` for log-only mode.

```bash
legalwork serve --workspace /path/to/workspace
```

`legalwork` ships as a compiled binary, so Bun is not required at runtime.

The npm platform package includes its local server and the engine's complete verified
artifact. GitHub raw-binary downloads and mirror overrides are retired. If npm skips
optional platform packages, enable optional dependencies and reinstall; no postinstall
network fallback fetches a standalone executable.

`--sidecar-source` and `--opencode-source` accept `auto`, `bundled` or `external`.
`auto` uses a local bundle or, for the engine, the exact prepared local archives/cache.
`--sidecar-dir` / `LEGALWORK_SIDECAR_DIR` control that local cache. The former
`downloaded`, `--sidecar-base-url`, `--sidecar-manifest` and download-mirror environment
variables fail with a retirement message before starting runtime work.

For development overrides only, set `LEGALWORK_ALLOW_EXTERNAL=1` or pass `--allow-external` to use
locally installed `legalwork-server` binaries.

Add `--verbose` (or `LEGALWORK_VERBOSE=1`) to print extra diagnostics about resolved binaries.

OpenCode 2 owns native configuration watching. The former hot-reload/debounce/cooldown
flags and environment variables remain parseable for existing launch commands, but emit
a compatibility diagnostic because the released engine no longer supports those controls.

In `start`/`serve`, the independently deployed LegalWork server owns one authenticated
OpenCode process, its private database, history readiness, and native service restart
continuity. Clients connect through LegalWork's authenticated Bearer proxy;
native Basic credentials stay private. Folder automation still requires approval
before an agent can run, including in `--approval auto` mode.

Runtime settings and the shared capability library keep their existing LegalWork storage.
Engine-generated config, service registration, and v2 database use a separate directory
under the orchestrator's `--data-dir`. This prevents stopping the CLI from stopping a
desktop-owned engine. The existing `none` versus Docker/container execution boundary is
preserved. Separate processes read the same saved settings; this does not add a cross-process
settings notification protocol.

Or from source:

```bash
pnpm --filter legalwork-orchestrator dev -- \
  start --workspace /path/to/workspace --approval auto --allow-external
```

When `LEGALWORK_DEV_MODE=1` is set, managed OpenCode uses private development config,
database, cache and service state without importing personal OpenCode history by default.
An explicit `OPENCODE_DB` override remains authoritative. LegalWork's repo-level `pnpm dev`
commands enable development mode automatically.

The command prints pairing URLs by default and withholds live credentials from stdout to avoid leaking them into shell history or collected logs. Use `--json` only when you explicitly need the raw pairing secrets in command output.

Use `--detach` to keep services running and exit the dashboard. The detach summary includes the
LegalWork URL and a redacted `opencode attach` command, while keeping live credentials out of the detached summary.

## Sandbox mode (Docker / Apple container)

`legalwork` can run the sidecars inside a Linux container boundary while still mounting your workspace
from the host.

```bash
# Auto-pick sandbox backend (prefers Apple container on supported Macs)
legalwork start --sandbox auto --workspace /path/to/workspace --approval auto

# Explicit backends
legalwork start --sandbox docker --workspace /path/to/workspace --approval auto
legalwork start --sandbox container --workspace /path/to/workspace --approval auto
```

Notes:

- `--sandbox auto` prefers Apple `container` on supported Macs (arm64), otherwise Docker.
- Docker backend requires `docker` on your PATH.
- Apple container backend requires the `container` CLI (https://github.com/apple/container).
- Sandbox mode requires Linux artifacts from local builds/prepared archives. It does not download standalone sidecars.
- On a non-Linux host, supply the locally built Linux server with `--legalwork-server-bin` and `--allow-external`.
  An explicit `--opencode-bin` must match the engine's compiled target and artifact pins.
- Use `--sandbox-image` to pick an image with the toolchain you want available to OpenCode.
- Use `--sandbox-persist-dir` to control the host directory mounted at `/persist` inside the container.

### Extra mounts (allowlisted)

You can add explicit, validated mounts into `/workspace/extra/*`:

```bash
legalwork start --sandbox auto --sandbox-mount "/path/on/host:datasets:ro" --workspace /path/to/workspace
```

Additional mounts are blocked unless you create an allowlist at:

- `~/.config/legalwork/sandbox-mount-allowlist.json`

Override with `LEGALWORK_SANDBOX_MOUNT_ALLOWLIST`.

## Logging

`legalwork` emits a unified log stream from OpenCode and LegalWork server. Use JSON format for
structured, OpenTelemetry-friendly logs and a stable run id for correlation.

```bash
LEGALWORK_LOG_FORMAT=json legalwork start --workspace /path/to/workspace
```

Use `--run-id` or `LEGALWORK_RUN_ID` to supply your own correlation id.

OpenCode runs at `INFO` by default, which produces large log files in
`~/.local/share/opencode/log/`. Pass `--opencode-log-level <DEBUG|INFO|WARN|ERROR>` (or set
`LEGALWORK_OPENCODE_LOG_LEVEL`) to forward `--log-level` to managed `opencode serve` and reduce log
volume.

LegalWork server logs every request with method, path, status, and duration. Disable this when running
`legalwork-server` directly by setting `LEGALWORK_LOG_REQUESTS=0` or passing `--no-log-requests`.

## Existing developer daemons

The extra developer engine launcher and its workspace/instance registry commands are retired. Use `legalwork serve --workspace /path/to/matter` for the supported server runtime. Self-hosting, manual server connections and file commands remain supported.

Original `legalwork-orchestrator-state.json` and private `opencode-config` files stay intact. `legalwork daemon status --data-dir <original-directory>` and `legalwork daemon stop --data-dir <original-directory>` remain available for an existing daemon. They verify its saved PID, start time and exact loopback health identity before requesting shutdown; they never start another engine or kill a saved PID.

## Pairing notes

- Use the **LegalWork connect URL** and **client token** to connect a remote LegalWork client.
- In `start`/`serve`, the **OpenCode connect URL** uses the LegalWork token through its
  scoped proxy; the native engine's Basic credentials are never advertised.

## Approvals (manual mode)

```bash
legalwork approvals list \
  --legalwork-url http://<host>:8787 \
  --host-token <token>

legalwork approvals reply <id> --allow \
  --legalwork-url http://<host>:8787 \
  --host-token <token>
```

## Health checks

```bash
legalwork status \
  --legalwork-url http://<host>:8787 \
  --opencode-url http://<host>:8787/opencode \
  --legalwork-token <client-token>
```

Managed status checks the authenticated native process identity and LegalWork's metadata-only startup readiness without activating a project. A direct standalone native server still accepts `--opencode-username` and `--opencode-password`.

## File sessions (JIT catalog + batch read/write)

Create a short-lived workspace file session and sync files in batches:

```bash
# Create writable session
legalwork files session create \
  --legalwork-url http://<host>:8787 \
  --token <client-token> \
  --workspace-id <workspace-id> \
  --write \
  --json

# Fetch catalog snapshot
legalwork files catalog <session-id> \
  --legalwork-url http://<host>:8787 \
  --token <client-token> \
  --limit 200 \
  --json

# Read one or more files
legalwork files read <session-id> \
  --legalwork-url http://<host>:8787 \
  --token <client-token> \
  --paths "README.md,notes/todo.md" \
  --json

# Write a file (inline content or --file)
legalwork files write <session-id> \
  --legalwork-url http://<host>:8787 \
  --token <client-token> \
  --path notes/todo.md \
  --content "hello from legalwork" \
  --json

# Watch change events and close session
legalwork files events <session-id> --legalwork-url http://<host>:8787 --token <client-token> --since 0 --json
legalwork files session close <session-id> --legalwork-url http://<host>:8787 --token <client-token> --json
```

## Smoke checks

```bash
legalwork start --workspace /path/to/workspace --check --check-events
```

This starts the services, verifies health + SSE events, then exits cleanly.

## Local development

Build the server JavaScript and run it with the development Node runtime:

```bash
pnpm --filter legalwork-server build
legalwork start \
  --workspace /path/to/workspace \
  --allow-external \
  --legalwork-server-bin apps/server/dist/cli.js
```
