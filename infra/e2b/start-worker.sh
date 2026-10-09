#!/usr/bin/env bash
set -euo pipefail
export HOME=/data/home
export XDG_CONFIG_HOME=/data/home/.config
export XDG_DATA_HOME=/data/home/.local/share
export XDG_CACHE_HOME=/data/home/.cache
export LEGALWORK_RUNTIME_DB=/data/runtime.sqlite
export LEGALWORK_MANAGE_OPENCODE=1
export LEGALWORK_OPENCODE_BIN=/usr/local/bin/opencode
export LEGALWORK_OPENCODE_PLUGINS_DIR=/opt/legalwork/opencode-plugins
export LEGALWORK_RESOURCES_DIR=/opt/legalwork/resources
export LEGALWORK_NATIVE_MODULES_DIR=/opt/legalwork/node_modules
mkdir -p "$HOME" /data/projects/Assistant
cd /opt/legalwork
while [ ! -f /data/server.json ]; do sleep 0.1; done
if [ -f /data/worker-sync.json ]; then
  export LEGALWORK_CLOUD_SYNC_CONFIG=/data/worker-sync.json
fi
exec /opt/legalwork/legalwork-server --config /data/server.json >> /data/worker.log 2>&1
