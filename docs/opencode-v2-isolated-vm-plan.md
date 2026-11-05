# Isolated Linux comparison — proposed infrastructure

## Windows preparation checkpoint — 2026-10-25

A separate read-only preflight found a viable Windows acceptance path; no
Windows resource, credential or budget reservation has been created. It must
not bypass the current Linux evidence-preservation/deletion boundary.

- Pin `windows-cloud/windows-server-2025-dc-v20261013`, image ID
  `4886251108749677966`, x64 with Desktop Experience. The Core image cannot
  establish visible Electron acceptance. Proposed machine: Frankfurt
  `e2-standard-8`, 32 GiB RAM, 200 GiB standard disk, four-hour DELETE lease,
  auto-delete disk and no service account/scopes.
- Use a Windows-targeted IAP-only TCP 3389 rule and loopback tunnel. The existing
  benchmark network permits TCP 22 only. The controller's installed Windows App
  can operate a real standard-user desktop; packaged CDP remains disabled.
  Administrator bootstrap and the standard app account must remain separate.
- Build a fresh frozen migration source copy on Windows using the release
  workflow's Node 24.22.1, pnpm 11.4.0 and Bun 1.4.2; packaged Node remains 22.23.4.
  Select the full independently pinned `.3` distribution in private build input,
  with no validation registration/preload. Do not copy Mac native dependencies.
- Exact latest-dev CI run `40140321239` retains Windows sandbox artifact
  `12578637251`, 259,038,370 bytes, ZIP digest
  `53c0289cd2e9c281b8da348b99dcda86de6fe6b50ea6e4fe94f1aeafd114250b`.
  Reuse only after archive/inner-manifest checks; keep GitHub credentials on the
  controller. Freeze the runtime allowlist and remove readable test answers,
  build staging and past traces before any paid task.
- Exercise actual packaged startup, native identity/ACLs, two-project ownership,
  normal trusted stores, MCP/Code Mode HTTP, Stop/restart and stdin recovery,
  then a real source task and live document edit/save/reopen. Raw trace recording
  must remain outside agent-readable files. A separate tampered package must
  fail startup and doctor before execution.
- The authenticated EUR catalog at 15:50–15:51 UTC prices Windows Server 2025 at
  EUR0.040479999 per visible vCPU-hour, additional to E2 CPU/RAM/disk/IP. Four
  hours is approximately EUR2.573984 fixed; ten GiB at the pessimistic captured
  egress rate brings the estimate to EUR4.597984. Reserve a separate EUR8 in the
  existing shared ledger before provisioning, refresh prices, and retain the
  invoice/egress qualification. This is not a new allowance above EUR100.

Allow roughly 60–120 minutes for setup/build and 30–60 for acceptance, with
15–30 GiB of build space; native compilation tools may add 25–40 GiB. These are
planning estimates. Windows Server 2025 x64 does not prove Windows 11/ARM64,
production signing/installer/updater, licensed Microsoft Office, or real external
connector OAuth. See [Google image support](https://docs.cloud.google.com/compute/docs/images/os-details),
[IAP tunneling](https://docs.cloud.google.com/sdk/gcloud/reference/compute/start-iap-tunnel),
[Windows session requirements](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services),
and [Windows image pricing](https://cloud.google.com/compute/disks-image-pricing#premiumimages).

## Original Linux proposal

Status: read-only cloud preflight completed 2026-10-24. No VM, network, firewall,
disk, external-budget reservation or model request has been created by this plan.
Provisioning follows the orchestrator's review. Model admission remains held
until the actual isolation proof is reviewed; the candidate also requires the
patched engine's direct and Code Mode MCP regressions to pass.

## Exact infrastructure

| Setting | Value and reason |
| --- | --- |
| Project / zone | `groovy-shore-499120-f9` / `europe-west3-a`; billing enabled and sufficient E2 CPU, disk, instance and IP quotas verified read-only. |
| Image | `ubuntu-os-cloud/ubuntu-2404-noble-amd64-v20261024`, image ID `4575951068918267275`; pin the image, not its moving family. |
| Machine | `e2-standard-8`, x86-64, 8 vCPUs, 32 GiB RAM, standard on-demand; no Spot interruption or GPU. |
| Storage | One 100 GiB zonal `pd-standard` boot disk per arm, automatic deletion. No snapshots, shared data disk or persistent IP. |
| Lifetime | Two **sequential** instances, each with an explicit four-hour cloud lease and termination action `DELETE`. Do not create V2 until V1 outputs are on the host and V1 deletion is verified. |
| Network | Dedicated `lw-ocv2-bench-20261024` custom VPC, subnet `10.251.77.0/24` in Frankfurt (no existing overlap), one ingress rule allowing TCP22 only from IAP `35.235.240.0/20`. No ingress rule for the app, model proxy or native engine. Ephemeral IPv4 for build downloads; no NAT/router/load balancer. |
| Cloud identity | No attached service account or OAuth scopes; project SSH keys blocked. One test-owned SSH public key for the controller. No production/cloud credentials in the guest. |
| App identity | Separate unprivileged `legalwork` account, private home, no sudo, docker, disk or controller group membership. Electron runs as this user with its normal sandbox, under Xvfb. Root/controller build files are removed before inference; package/runtime is root-owned and read-only to the app. |

E2 does not support nested KVM. This does not change LegalWork's Linux runtime:
both frozen dev and the candidate select QEMU **TCG** on Linux, and the Linux
release workflow builds QEMU with TCG. No KVM branch exists in either arm's
`VmSandbox`. The benchmark records the actual `host` / `virtual-machine` shell
mode and, when enabled, proves the shipped protected runtime works. It does not
change the user's default shell/sandbox setting. Linux TCG timing must not be
compared directly with the earlier macOS timing. See [Google's nested
virtualization restrictions](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview).

The lease is a test infrastructure cost stop, **not a product agent deadline**.
A run approaching expiry is held before another scenario; a lease interruption
makes that run incomplete. Any extension needs another recorded shared-budget
reservation before changing the cloud lifetime. Full traces and artifacts are
mirrored to the controller. Automatic disk deletion can still lose files that
have not reached the host during a network outage; do not call such evidence
complete. [Compute Engine supports automatic VM termination and disk
deletion](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime).

## Metered cost and shared allowance

The actual authenticated Cloud Billing Catalog EUR snapshot was read at
2026-10-24T21:18Z, effective 2026-10-24T07:00Z. A sanitized seven-SKU receipt is
stored privately in `cloud-pricing-preflight.json` beside the controller's VM
evidence. No account discount, free tier or commitment is assumed.

| Item | Verified EUR price | Eight total lease hours |
| --- | ---: | ---: |
| Frankfurt E2 core, SKU `C921-088E-792A` | 0.024731255 / vCPU hour | 1.58280032 |
| Frankfurt E2 RAM, SKU `7D80-F9E4-6A44` | 0.003314097 / GiB hour | 0.848408832 |
| Frankfurt zonal PD, SKU `7A7B-EA46-2897` | 0.042239999 / GiB month | 0.045419354 |
| External IPv4, SKU `C054-7F72-A02E` | up to 0.004399999 / hour | 0.035199992 |
| **Fixed compute/disk/IP subtotal** | | **2.511828498** |

Disk calculation uses the SKU's 744-hour month. Cloud transfer to the European
host is at most EUR0.105599999/GiB at the first paid tier in the captured EMEA/
Western Europe SKUs. The captured most expensive EMEA destination rate is
EUR0.202399999/GiB. Inbound downloads are free; outgoing requests and copied
artifacts are metered. [Google's network pricing](https://cloud.google.com/vpc/network-pricing)
and [IAP pricing](https://cloud.google.com/iap/pricing) describe the distinction.

Propose **EUR8 external reservation** in the existing migration ledger before
the first charged resource. Planning assumption: no more than 10 GiB total
outgoing traffic, conservatively costed at EUR0.202399999/GiB, so the estimate is
EUR4.535828488 and the reservation leaves EUR3.464171512 headroom. That same
reservation accommodates approximately 27.1 GiB at the conservative rate after
the fixed subtotal. This is an estimate and reservation, **not an unconditional
hard cap on Google's invoice**. There is no hidden output-size or network
truncation. Record guest interface byte counters, tunnel/file-transfer bytes and
resource lifetimes; reconcile against billing evidence when available. Hold new
scenarios or a large controller transfer for additional reservation if the
remaining allowance cannot cover its measured size. A live operation can exceed
an estimate; report it and preserve its data rather than claiming a hard bound.

Use `createBudgetGuard` with the same absolute ledger and a freshly refreshed
production model-info audit, then `reserveExternal({requestId, label,
maxEur:8})`. Persist its token privately before any `gcloud ... create`. Creation
failure, cancellation or ambiguous billing does not silently release the hold.
Only `settleExternal` with authoritative cost evidence can reconcile it. Do not
reset the user's EUR100 allowance. Refresh tariffs if this plan is provisioned
later. Existing inference costs/uncertain holds remain in the ledger.

## Runtime and files that may enter an arm

1. Build the exact frozen V1 source and candidate source separately, using each
   frozen pnpm lockfile and the release pipeline's pinned toolchain. Package the
   actual Linux Electron renderer, embedded LegalWork server, native modules,
   first-party plugins, OCR, Word add-in and protected execution assets. V1 uses
   its verified `1.18.29` engine. V2 uses the separately verified
   `linux-x64-baseline` patched artifact `2.1.4-legalwork.mcp-ready.1` when ready.
   A missing Linux asset is a blocker; do not substitute macOS binaries, host
   execution or an engine-only test for Electron parity.
2. Builder staging is private to the controller/root. After packaging, copy an
   allowlisted runtime to the app account, then remove the source checkout,
   build logs, git state, test files, fixture JSON, dependency caches and builder
   staging before inference. The current `tsc` output includes server test JS,
   and desktop packaging includes Electron test files: the test-only staging
   assembly must remove these from **both** arm artifacts and verify production
   imports still resolve. Do not assume an ASAR hides its contents.
3. Copy every actually selected LegalWork skill and its full resource files,
   retaining original hashes and relative structure. No recursive promotion of
   unselected vendor/test packages. Compare the selected-skill manifest between
   arms. Built-in native additions remain explicit catalog differences.
4. Copy only each task's source documents to its workspace. Host-only: complete
   suites, criteria, expected answers, generator code, `task.json`, original
   traces, prior outputs, judge inputs and verdicts. Root's new >1MiB synthetic
   source is prepared once on the host and copied byte-identically to both arms;
   its expectations never enter a guest. No host-home mounts.
5. Pull all result/history/artifact evidence to a private host directory. Delete
   the entire V1 VM/disk before creating fresh V2. Do not reuse the first arm's
   app profile, browser cache, workspace, runtime DB or outputs in the second.

The engine patch uses upstream's original root package/Bun lock and Bun1.4.4
frozen installation; the provisional pnpm conversion and its apparent 211
dependency changes are not adopted. Its source changes are the MCP registry fix,
MCP tests and a three-line registry test-fixture adjustment. It changes no
LegalWork benchmark prompt, fixture, model selection or guard configuration.
Record both actual engine build manifests and each arm's runtime/source hashes.

## Host-only control and zero-inference gate

Use test-only SSH/IAP tunnels to the guest's loopback Electron UI-control and
LegalWork server endpoints. Keep suites, assertions and evaluation on the host.
This does not reintroduce product remote workers. A reverse loopback tunnel gives
the engine the host's guarded capture proxy; only its throwaway local proxy token
enters the guest. The production gateway key, tariff audit and budget ledger
remain on the host. Loss of the tunnel fails inference instead of falling back
to another provider. Never expose native Basic credentials or arbitrary public
RPC. Full model bytes are captured on the host before any judging.

Before model dispatch, publish an isolation receipt showing:

- image, OS, UID/groups, app/runtime/engine hashes and selected source/skill
  manifests; no prior answers, traces, criteria or build staging in any app-
  readable file tree;
- actual read, shell and other available file-tool attempts against test-owned
  forbidden sentinel paths cannot recover their contents; a root-private local
  sentinel exists as a positive permission-boundary control, and a controller-
  only sentinel never enters the guest;
- no service-account token, production gateway key, inherited host credential,
  host-home mount or readable controller path; only the scoped model tunnel;
- real Electron startup, model transport fingerprint, full catalog/skill
  coverage, working Word/browser controls and unchanged default permissions;
- actual shipped Linux protected execution positive control and its mode/TCG
  evidence, independently of the unchanged default shell setting;
- a deterministic local model/transport canary proves capture/routing without
  a paid request, followed by a parent-reviewed gate before real inference.

Fresh filesystems prevent the observed local-answer contamination. Public
Harvey tasks/criteria can still be found online by a network-capable agent.
Keep normal research capabilities and inspect full tool/network provenance;
consulting a public rubric or previous deliverable invalidates that quality
sample. Do not claim internet hermeticity or eliminate capabilities silently.

## Creation commands for review

Run each as an argument array after the durable external reservation exists.
Use test-owned names and local public-key metadata only. The proposed creation
wrapper must record the actual `--termination-time` (four hours from request), instance IDs,
disk IDs, command arrays and reservation identity before returning control.

```sh
gcloud compute networks create lw-ocv2-bench-20261024 --project=groovy-shore-499120-f9 --subnet-mode=custom
gcloud compute networks subnets create lw-ocv2-bench-20261024 --project=groovy-shore-499120-f9 --network=lw-ocv2-bench-20261024 --region=europe-west3 --range=10.251.77.0/24
gcloud compute firewall-rules create lw-ocv2-bench-20261024-iap --project=groovy-shore-499120-f9 --network=lw-ocv2-bench-20261024 --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20
gcloud compute instances create ARM_INSTANCE --project=groovy-shore-499120-f9 --zone=europe-west3-a --machine-type=e2-standard-8 --image-project=ubuntu-os-cloud --image=ubuntu-2404-noble-amd64-v20261024 --subnet=lw-ocv2-bench-20261024 --boot-disk-size=100GB --boot-disk-type=pd-standard --boot-disk-auto-delete --no-service-account --no-scopes --no-restart-on-failure --metadata=block-project-ssh-keys=TRUE,enable-oslogin=FALSE,serial-port-enable=FALSE --metadata-from-file=ssh-keys=CONTROLLER_PUBLIC_KEY_METADATA --termination-time=RECORDED_FOUR_HOUR_EXPIRY --instance-termination-action=DELETE
```

Instance names are `lw-ocv1-bench-20261024` and `lw-ocv2-bench-20261024`. Automatic
deletion is the fallback; the controller normally deletes each exact owned
instance after collecting evidence and verifies its disk and ephemeral IP are
gone. Finally delete only the owned firewall, subnet and VPC. Reconcile the
external hold; retained/uncertain billing stays visible. Never change an existing
instance, shared network/firewall, global gcloud configuration or project budget.
