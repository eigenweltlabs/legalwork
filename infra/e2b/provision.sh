#!/usr/bin/env bash
# Re-runnable provisioning of isolated resources; never changes gcloud defaults.
set -euo pipefail
project=${GCP_PROJECT:-groovy-shore-499120-f9}
zone=${GCP_ZONE:-europe-west3-a}
region=${zone%-*}
name=${E2B_HOST_GROUP:-legalwork-e2b}
template="$name-${E2B_TEMPLATE_REVISION:-v3}"
script_dir=$(cd "$(dirname "$0")" && pwd)
gc() { gcloud --project="$project" --quiet "$@"; }
gc services enable compute.googleapis.com iam.googleapis.com iap.googleapis.com cloudresourcemanager.googleapis.com
if ! gc compute networks describe "$name" >/dev/null 2>&1; then
  gc compute networks create "$name" --subnet-mode=custom
fi
if ! gc compute networks subnets describe "$name" --region="$region" >/dev/null 2>&1; then
  gc compute networks subnets create "$name" --network="$name" --region="$region" --range=10.77.0.0/24
fi
sa="$name@$project.iam.gserviceaccount.com"
if ! gc iam service-accounts describe "$sa" >/dev/null 2>&1; then
  gc iam service-accounts create "$name" --display-name='LegalWork E2B host (no project permissions)'
fi
if ! gc compute firewall-rules describe "$name-iap" >/dev/null 2>&1; then
  gc compute firewall-rules create "$name-iap" --network="$name" --direction=INGRESS \
    --source-ranges=35.235.240.0/20 --target-service-accounts="$sa" --allow=tcp:22
fi
if ! gc compute firewall-rules describe "$name-health" >/dev/null 2>&1; then
  gc compute firewall-rules create "$name-health" --network="$name" --direction=INGRESS \
    --source-ranges=35.191.0.0/16,130.211.0.0/22 --target-service-accounts="$sa" --allow=tcp:3000
fi
if ! gc compute resource-policies describe "$name-backup" --region="$region" >/dev/null 2>&1; then
  gc compute resource-policies create snapshot-schedule "$name-backup" --region="$region" \
    --daily-schedule --start-time=02:00 --max-retention-days=7 \
    --on-source-disk-delete=apply-retention-policy --storage-location="$region"
fi
if ! gc compute instance-templates describe "$template" >/dev/null 2>&1; then
  gc compute instance-templates create "$template" --machine-type=n4-standard-8 --region="$region" \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=50GB --boot-disk-type=hyperdisk-balanced \
    --create-disk="device-name=e2b-data,size=200GB,type=hyperdisk-balanced,auto-delete=no,disk-resource-policy=$name-backup" \
    --network="$name" --subnet="projects/$project/regions/$region/subnetworks/$name" \
    --enable-nested-virtualization --service-account="$sa" --scopes=cloud-platform \
    --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
    --metadata-from-file="startup-script=$script_dir/startup.sh" \
    --labels=app=legalwork,component=e2b,environment=development
fi
if ! gc compute health-checks describe "$name" >/dev/null 2>&1; then
  gc compute health-checks create http "$name" --port=3000 --request-path=/health \
    --check-interval=30s --timeout=10s --unhealthy-threshold=10 --healthy-threshold=1
fi
if ! gc compute instance-groups managed describe "$name" --zone="$zone" >/dev/null 2>&1; then
  gc compute instance-groups managed create "$name" --zone="$zone" --size=1 --template="$template" \
    --base-instance-name="$name" --stateful-disk=device-name=e2b-data,auto-delete=never \
    --health-check="$name" --initial-delay=1200 \
    --update-policy-type=opportunistic --update-policy-replacement-method=recreate \
    --update-policy-max-surge=0 --update-policy-max-unavailable=1
fi
gc compute instance-groups managed set-instance-template "$name" --zone="$zone" --template="$template" --format=none
gc compute instance-groups managed update "$name" --zone="$zone" --force-update-on-repair --format=none
gc compute instance-groups managed list-instances "$name" --zone="$zone" \
  --format='table(instance.basename(),instanceStatus,currentAction)'
