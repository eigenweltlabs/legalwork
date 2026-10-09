#!/usr/bin/env bash
# Run on the dedicated host after copying the binary and service here.
set -euo pipefail
install -d -m 0700 /data/controller
if [ ! -s /data/controller/admin-token ]; then
  umask 077
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /data/controller/admin-token
fi
cat > /opt/e2b/controller.env <<'EOF'
CONTROLLER_TOKEN_FILE=/data/controller/admin-token
CONTROLLER_DB=/data/controller/workers.sqlite
CONTROLLER_PORT=8788
E2B_API_KEY_FILE=/var/lib/docker/volumes/e2b_seed-state/_data/team-api-key
E2B_API_URL=http://127.0.0.1:3000
E2B_SANDBOX_URL=http://127.0.0.1:3002
E2B_LEGALWORK_TEMPLATE=legalwork-sync-v1
# Development workers do not yet have an Eigenwelt/model connection.
# Turn this off when user connection provisioning is available.
ALLOW_UNSYNCED_DEVELOPMENT_WORKERS=1
EOF
chmod 600 /opt/e2b/controller.env
install -m 0644 /opt/e2b/controller.service /etc/systemd/system/legalwork-vm-controller.service
systemctl daemon-reload
systemctl enable --now legalwork-vm-controller
