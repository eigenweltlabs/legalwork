#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
project=${GCP_PROJECT:-groovy-shore-499120-f9}
zone=${GCP_ZONE:-europe-west3-a}
name=${E2B_HOST_GROUP:-legalwork-e2b}
instance=$(gcloud compute instance-groups managed list-instances "$name" --project="$project" --zone="$zone" --format='value(instance.basename())')
[ -n "$instance" ]
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cd "$root"
pnpm --filter @legalwork/cloud-vm typecheck
pnpm --filter @legalwork/cloud-vm exec bun build --compile --target bun-linux-x64 src/server.ts --outfile "$stage/legalwork-vm-controller"
gzip -c "$stage/legalwork-vm-controller" > "$stage/legalwork-vm-controller.gz"
gcloud compute scp "$stage/legalwork-vm-controller.gz" infra/e2b/controller.service infra/e2b/install-controller.sh \
  "$instance:/tmp/" --project="$project" --zone="$zone" --tunnel-through-iap --quiet
gcloud compute ssh "$instance" --project="$project" --zone="$zone" --tunnel-through-iap --quiet --command='sudo bash -s' <<'REMOTE'
set -euo pipefail
systemctl stop legalwork-vm-controller || true
gzip -dc /tmp/legalwork-vm-controller.gz > /opt/e2b/legalwork-vm-controller.new
chmod 755 /opt/e2b/legalwork-vm-controller.new
mv /opt/e2b/legalwork-vm-controller.new /opt/e2b/legalwork-vm-controller
install -m 0644 /tmp/controller.service /opt/e2b/controller.service
if [ -f /opt/e2b/controller.env ]; then
  # Upgrades preserve operator settings, keys and user mappings.
  install -m 0644 /opt/e2b/controller.service /etc/systemd/system/legalwork-vm-controller.service
  systemctl daemon-reload
  systemctl start legalwork-vm-controller
else
  bash /tmp/install-controller.sh
fi
systemctl is-active legalwork-vm-controller
REMOTE
