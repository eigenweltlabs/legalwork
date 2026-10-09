# Personal assistant cloud sync

The desktop and VM reuse Eigenwelt project sync. There is no second project file manifest or transfer service. Shared documents keep their existing project ID, file index, 8 MiB transfer chunks, conflicts and deletion recovery. Projects without teammates use the existing owner-only `members` access with an empty member list.

Private assistant data lives in one owner-only project with `purpose: personal-state`, accessed through the same project/file/blob APIs. The platform hides it from project lists and refuses team sharing. Files omitted from a project's team-sharing scope, private reviews, skills, commands, agents and chat attachments use private prefixes there; they reuse the existing file/review comparison engines. Shared document bytes are not copied into this private project.

## State and execution ownership

An offline initial handoff copies the workspace catalog, original workspace/session/message/part IDs, assistant days and profile, session groups, schedules, local tasks and calendar records. SQLite snapshots include committed WAL data. Project details and instructions also travel privately, including when their team-sharing switch is off. Permissions, personalization and safe custom agent fields subsequently sync independently using original edit timestamps. Restore maps project paths and file URLs to VM paths; literal conversation text stays unchanged. External directory grants are retained only for replicated roots. Server approval mode is included in the checkpoint.

Credential stores, provider and connector configuration, plugins, calendar subscription secrets, derived caches, sync cursors and local transfer bases are excluded. Existing target credentials remain local. Root `opencode.json` and `opencode.jsonc` files are excluded from cloud document transfer; safe runtime settings and skill/agent files have explicit paths instead. A project may still contain ordinary user files with sensitive content, just as it can with team sync.

One process owns session execution. A conditional control file holds its owner, generation, expiry and checkpoint pointer. Heartbeats renew the lease independently of file transfers; an expired or replaced owner cannot publish another checkpoint, and a running managed engine is stopped when ownership is lost. Files-role desktops can edit and sync documents, tasks and safe preferences, but must connect to the VM worker to run assistant sessions. The existing **Add a worker → Connect remote** flow is the client entry point.

## Startup and file availability

1. Start the installed LegalWork binary and acquire execution ownership.
2. Restore the latest runtime/engine checkpoint before launching the managed engine. A matching local checkpoint retains its databases. An interrupted restore is replayed from its local journal.
3. Register all original project IDs and paths. Sync the Assistant project and any explicitly requested or previously downloaded projects.
4. Download another project when preparing its first agent request or reading it through the project/file APIs. The project must finish transfer before execution proceeds. Call the prepare endpoint explicitly before using a project's path through an external filesystem consumer.
5. Continue ordinary project deltas. Cached files, file bases and indexes stay on the VM disk. A missing project directory resets its local bases and restores files instead of propagating an empty folder as deletions.

A VM resume keeps its disk and memory; it does not restore all project files again. A replacement VM downloads the state checkpoint and requested projects. Checkpoint databases are content-addressed in 8 MiB pieces so unchanged pieces are reused. Project documents continue to use the existing whole-file version/chunk behavior: a changed document gets a new version, while unchanged documents transfer no bytes.

## Configuration and handoff

Deploy the companion [Model API integration](https://github.com/eigenweltlabs/model-api/pull/87) and its project routes first. Its current forward migration is `0045_personal_sync_purpose`; follow the database-history checks in [assistant-integration.md](https://github.com/eigenweltlabs/model-api/blob/codex/assistant-channel-integration/docs/assistant-integration.md) before applying it to an existing database. The legacy VM branch's `0031_personal_sync_purpose` must not be substituted into the current migration journal. LegalWork refuses to upload state if the platform does not confirm the protected personal-state type. This implementation uses an already configured Eigenwelt connection; VM credential provisioning is deliberately a later step.

Create a sync profile on the desktop:

```json
{
  "version": 1,
  "accountId": "user_stable_identifier",
  "deviceId": "desktop",
  "deviceName": "My computer",
  "store": { "type": "platform" },
  "role": "files",
  "projectIds": [],
  "intervalMs": 30000,
  "leaseMs": 180000
}
```

Use the same account ID on the VM and a different device ID. `accountId` identifies this private replica within the current Eigenwelt organization; use a stable user-specific value. An empty desktop `projectIds` selects all local projects. Restrict it to exact workspace IDs to opt into particular projects.

With LegalWork stopped, seed the cloud copy:

```sh
legalwork-server sync seed --sync-config /path/to/desktop-sync.json --config /path/to/server.json
```

The desktop can then start normally with `LEGALWORK_CLOUD_SYNC_CONFIG=/path/to/desktop-sync.json`. Removing the last teammate stops sharing while retaining the owner's enabled cloud copy. To disable cloud sync entirely, stop the server and remove that environment setting; existing cloud data is retained.

The VM profile uses `role: "executor"`, `deviceId: "worker"`, and `projectsDirectory: "/data/projects"`. Leave `projectIds` empty for on-demand projects, or provide exact IDs to download them during startup. Keep the server config, runtime database, device marker, local transfer bases and project directories on persistent VM storage. The first version assumes one desktop workspace catalog is handed off to the VM; clients on other entry points connect to this execution owner.

Preinstall the LegalWork server, its pinned OpenCode version from `constants.json`, bundled workflows/plugins and the document tools your workloads need into the VM image. The E2B template uses bundled JavaScript under Linux Bun with separately built Linux native dependencies. Prepare these assets without provisioning a user VM:

```sh
LEGALWORK_SOURCE=/path/to/legalwork /path/to/model-api/infra/e2b/prepare-template.sh
```

Start the VM's managed engine:

```sh
LEGALWORK_CLOUD_SYNC_CONFIG=/data/worker-sync.json \
LEGALWORK_MANAGE_OPENCODE=1 \
LEGALWORK_OPENCODE_BIN=/usr/local/bin/opencode \
legalwork-server --config /data/server.json
```

The execution profile requires the managed private engine database. External engine URLs, `OPENCODE_DB` overrides and development database isolation are rejected. Authenticated transport and model/connector access must already exist on the target; this change does not establish them.

For an intentional offline replacement of nonempty target state:

```sh
legalwork-server sync restore --sync-config /data/worker-sync.json --config /data/server.json --replace
```

Without `--replace`, an existing assistant history is preserved and restore refuses. Credential-only target configuration does not count as an existing assistant history. Local `.before-cloud-sync` database backups and the restore staging directory stay on the target for recovery.

`sync files` runs one desktop file/preferences round; `sync status` prints ownership, checkpoint time and the next active scheduled run. Large held-back deletions use the existing recovery flow; `sync files --allow-deletions` explicitly permits them.

## VM controller contract

The following host APIs work independently of E2B, Firecracker, GCE or another VM provider:

| Endpoint | Purpose |
| --- | --- |
| `GET /cloud-sync/status` | Client-authenticated `{ enabled, status }`; when enabled, `status` includes role, `canExecute`, checkpoint time and `nextRunAt`. |
| `POST /cloud-sync/projects/:id/prepare` | Host-authenticated project availability barrier. Failures remain blocked rather than executing against a partial folder. |
| `POST /cloud-sync/checkpoint` | Host-authenticated quiesce and checkpoint. Rejects active engine sessions. Success keeps execution quiesced. |
| `POST /cloud-sync/resume` | Host-authenticated ownership renewal, file/preferences catch-up and execution resume. Rejects a VM whose ownership was replaced. |

Before pausing a VM, call checkpoint and wait for success, then pause through the provider. After resuming its snapshot, call resume before accepting messages. If pause fails, call resume to release the quiesce. A controller must block a resumed VM that reports ownership loss; restoring a replacement requires a deliberate new handoff from the latest checkpoint. Regular shutdown checkpoints after stopping execution and releases ownership. The [Model API VM controller](https://github.com/eigenweltlabs/model-api/tree/codex/assistant-channel-integration/apps/cloud-vm) reads `nextRunAt`, renews provider timeouts and wakes paused workers. Its durable channel adapter connects native iOS, WhatsApp and email ingress to the Main Assistant. Real-user desktop handoff remains an explicit provisioning step.

## Channel execution

`LEGALWORK_CHANNEL_IDENTITY` points to a private controller-written `{userId,orgId}` file.
Host-only `/channel-runtime/jobs`, `/jobs/:id`, `/jobs/:id/cancel`, `/state`,
`/commands` and `/jobs/:id/files/:index` use the existing host authentication.
The ordinary worker proxy cannot expose them. Ownership is immutable in the
runtime database and execution must hold the existing cloud executor lease.

Each transport job journals a deterministic engine message ID before dispatch.
Retries recover that exact message or its cached final result; an uncertain
acceptance is never permission to send another prompt. Conversation mappings,
receipts, exact approval revisions and command outcomes persist in runtime.sqlite.
The controller holds its lifecycle lease while the agent runs or waits for input.
Lease cancellation stops only the still-active job and its delegated children;
cancelling an already completed receipt cannot stop a newer turn.

Prompts run through the existing Main Assistant with ordinary permissions.
Only final text and explicit verified share-file tool results leave through the
channel. Incoming media is confined to `LEGALWORK_CHANNEL_INBOX/<jobId>`;
deliverables refer to their original project files. Approvals/questions validate
the pending request revision, schedule updates validate the current task revision,
and stop commands include assistant delegations and real child sessions. The
Model API owns queue claims, membership checks, outbound channel delivery and
mobile runtime revisions; no machine/platform bearer is copied into the guest.

## Cloud browser tools

The VM template installs a local, authenticated Browser Use worker and configures `LEGALWORK_CLOUD_BROWSER_AUTH` with its token-file path. LegalWork's managed engine loads `legalwork_cloud_browser_task` and `legalwork_cloud_browser_status` when that configuration exists. A task supplies a starting URL, approved HTTPS origins and the current project path. It returns a durable task ID; completed downloads land in that project's `Downloads` directory and use the existing project sync.

When a website needs login, the status response contains a user-bound credential-entry link. The user signs in through the browser and saves the website login into their 1Password vault. The browser agent then resumes the waiting task. Passwords, the host's 1Password service-account token and private browser authentication profiles stay outside project sync and chat responses. The controller, credential page, vault integration and browser implementation live in Model API. A failed browser task may already have performed website actions and must not be replayed automatically.

Live GCP validation covered a dummy website login, same-agent continuation, a downloaded report, credential reuse and browser state after VM pause/resume. This validates browser infrastructure independently of connector transport. Mobile/WhatsApp/email messages still need the durable channel-to-VM runtime adapter described in the companion integration document.

## Validation and current limits

Tests exercise WAL snapshots, interrupted restores, stable session IDs, path remapping, private metadata, credential exclusion/preservation, chunk reuse and corruption checks, ownership fencing, preference convergence, on-demand project files, private reviews and retaining private sync when team sharing ends. Platform integration tests use PostgreSQL and the existing file routes to verify owner-only access and sharing rejection. Both server/platform typechecks and Linux cross-compilation are available locally.

The sync tests do not use real-user credentials or a deployed platform. VM orchestration, E2B templates, provisioning and infrastructure tests live in the Model API repository, outside LegalWork. The LegalWork server exposes only the provider-independent sync and checkpoint APIs. Real-user handoff still requires the companion platform deployment and target connections. Credentials and OS-dependent integrations require separate setup. Unlinked desktop recordings and arbitrary external folders are not mirrored. Background checkpoints are consistent per database; the quiesced checkpoint API is the handoff boundary. Immutable checkpoint chunks currently remain in storage; retention/garbage collection must be added before a long-running production rollout. Removing projects from a secondary desktop catalog and merging independently created local workspace IDs across desktops are also outside this first handoff flow.
