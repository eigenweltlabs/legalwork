#!/usr/bin/env bash
set -euo pipefail
project=${GCP_PROJECT:-groovy-shore-499120-f9}
zone=${GCP_ZONE:-europe-west3-a}
name=${E2B_HOST_GROUP:-legalwork-e2b}
instance=$(gcloud compute instance-groups managed list-instances "$name" --project="$project" --zone="$zone" --format='value(instance.basename())')
[ -n "$instance" ]
exec gcloud compute ssh "$instance" --project="$project" --zone="$zone" --tunnel-through-iap -- \
  -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:3000:127.0.0.1:3000 -L 127.0.0.1:3001:127.0.0.1:3001 \
  -L 127.0.0.1:3002:127.0.0.1:3002 -L 127.0.0.1:8788:127.0.0.1:8788 \
  -L 127.0.0.1:5008:127.0.0.1:5008
