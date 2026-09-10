#!/usr/bin/env bash
set -euo pipefail
storage_fixture_root="${LEGALWORK_STORAGE_FIXTURES:-/tmp/legalwork-storage-fixtures}"
mkdir -p "$storage_fixture_root/dev-workspace"
export LEGALWORK_DEV_MODE=1 LEGALWORK_MANAGE_OPENCODE=1
export LEGALWORK_DATA_DIR="$storage_fixture_root/dev-data"
export LEGALWORK_RUNTIME_DB="$storage_fixture_root/dev-runtime.sqlite"
export LEGALWORK_TOKEN_STORE="$storage_fixture_root/dev-tokens.json"
export LEGALWORK_STORAGE_STORE="$storage_fixture_root/dev-storage.json"
export LEGALWORK_ENV_STORE="$storage_fixture_root/dev-env.json"
export XDG_CONFIG_HOME="$storage_fixture_root/dev-xdg/config"
export XDG_DATA_HOME="$storage_fixture_root/dev-xdg/data"
export XDG_CACHE_HOME="$storage_fixture_root/dev-xdg/cache"
export NODE_EXTRA_CA_CERTS="$storage_fixture_root/ftps-cert.pem"
exec pnpm --filter legalwork-server exec bun src/cli.ts \
  --host 127.0.0.1 --port 19287 --approval auto \
  --config "$storage_fixture_root/dev-server.json" \
  --workspace "$storage_fixture_root/dev-workspace" \
  --token storage-dev-client --host-token storage-dev-owner
