# Multi-device and firm-hosted mail scope

MAIL-163, 1 November 2026. Scope decision for PR #130 at schema 37. This is an architecture and capacity assessment. Hosted mail, replica synchronization and an always-on scheduler are not implemented or enabled by this document.

## Decision and current boundary

Keep the shipped local-first client as the default. If a firm establishes a need for mail while devices are closed, the candidate is an explicitly enabled, per-user worker in firm-controlled infrastructure, using the same Email client and Integrations account. It is not a second email login or a tenant-wide shared inbox. An opaque backup relay is a different, smaller option when the need is device recovery rather than background execution.

No pilot deployment need, agreed availability target or approved operating budget is recorded in MAIL-163. Complete the core release gates in MAIL-156 before starting the hosted work packages below. Do not enable a remote endpoint, provision infrastructure or copy credentials as part of this scope.

Current source establishes these boundaries:

| Current implementation | Implication for a hosted extension |
| --- | --- |
| [Desktop mail runtime](../apps/desktop/electron/mail-runtime.mjs) fixes the owner to `desktop-local` and the database to the OS profile | This constant is not a cloud user identity or tenant boundary. An external authenticated owner registry and trusted worker bootstrap are required. |
| [Mail routes](../apps/server/src/routes/mail.ts) register only on loopback and require the local host actor | Do not expose `/mail/v1`, forward the host token, or change the bind address to obtain remote mail. A separate authenticated replica/control transport must call the existing internal service. |
| [Key store](../apps/desktop/electron/mail-key-store.mjs) wraps a random 32-byte database key with OS safe storage | A server needs its own reviewed key custody. Copying an OS key file or using a shared environment-variable key is insufficient. |
| [Integration proxy](../apps/server/src/mail/integration-proxy.ts) owns provider requests, account proof and current permissions | Keep this authority boundary. Worker placement must not create another refresh-token store or broaden Mail/Calendar/shared-mailbox grants. |
| [Mail schema](../apps/server/src/mail/storage/schema.ts), [content store](../apps/server/src/mail/storage/content-store.ts) and [action journal](../apps/server/src/mail/storage/action-journal.ts) are single-writer local state | Replicate validated records and immutable blobs, not a live SQLite/WAL file among writers. |
| [Agent grants](../apps/server/src/mail/storage/agent-grants.ts) bind account, workspace, directory, optional matter, permissions, expiry and credential generation | Device/worker authentication must remain separate from authority to search, attach, file or propose a send in a matter. |
| [Restore quarantine](../apps/server/src/mail/storage/recovery-quarantine.ts) disables authority and old pending work | Recovery and a new device cannot revive old sends, rules, approvals or provider draft mappings. |

## Deployment choices

| Mode | Custody and offline behavior | What it can do while all devices are closed |
| --- | --- | --- |
| Independent local clients, current default | Each device has its own encrypted cache, keys, local drafts, snoozes, rules and Outbox. The provider synchronizes provider state. | Nothing in LegalWork. A provider-side rule remains a provider feature. |
| Opaque encrypted backup relay, optional future scope | Owner-approved encrypted snapshots/blobs and recovery envelopes only. Relay has no decryption keys or provider grants. Local reading/search remains available. | Store/retrieve ciphertext. It cannot read, index, fetch a mailbox or execute a scheduled send. |
| Per-user hosted worker, candidate for an established firm need | Firm runtime can decrypt that owner's mail and exercise explicitly delegated provider capabilities. Devices keep independently encrypted offline replicas. | Synchronize and attempt acknowledged scheduled work while the service and provider are available. No exact delivery guarantee. |

A hosted plaintext-processing worker is not end-to-end encrypted against its operator. Tenant-controlled wrapping keys reduce custody scope and enable revocation; they do not make a worker that decrypts mail blind. The product must describe this trust change before activation. Tenant administration alone must not grant mailbox access through the application, even though an infrastructure operator with decryption authority remains inside the disclosed trust boundary.

## Ownership, isolation and key custody

The authoritative principal is `(deployment, tenant, identity issuer, immutable user subject)`, established by the authenticated session and server membership registry. A mailbox binding also pins provider, immutable provider subject, connection generation and any verified shared/delegated mailbox identity. Email addresses, display names, client-supplied `ownerId`, project names and `desktop-local` are never ownership proof. Equal mailbox addresses across tenants or owners do not merge stores.

Start with a private worker/database/key namespace per owner. One owner can have several accounts. The server registry chooses the worker, filesystem root and internal owner ID; the replica request cannot supply them. Tenant and owner checks apply before queues, blobs, searches, manifests, notifications, logs, exports and recovery, including existence checks and pagination. Content hashes are integrity checks, not authorization or cross-owner deduplication keys. Cross-tenant cache entries, queue keys and object names must include the authenticated ownership namespace.

Use a separate random data-encryption key per owner store and separate key purposes for provider credentials, replicas and recovery. A firm-controlled key service wraps server keys with tenant/owner/deployment context. Workers obtain only their current key lease through workload identity, with bounded lifetime and audited use. The control database stores references and wrapped material, not a universal unwrapping secret. Rotation is versioned and crash-recoverable across database, blobs, journals and backups. A revoked key lease or unavailable custody service prevents new worker decryption/dispatch; it does not convert incomplete work into a retryable send.

Each approved device has its own key pair, local OS-wrapped cache key, signed enrollment and revocable device capability. Enrollment requires the owner's existing authenticated account plus an existing device/recovery proof or an explicit, audited recovery procedure. A tenant admin reset is not a silent mailbox enrollment. Wrap replica recovery material to approved device keys. Revocation stops future server access/key delivery. It cannot promise to erase plaintext or keys already downloaded to an offline device. A lost-device incident needs that explicit limit.

Gmail/Outlook sign-in and refresh stay in Integrations. A hosted deployment uses a provider registration and redirect/client type suitable for that deployment, reached through the same account controls. Moving custody requires explicit enablement, provider identity proof and reconsent where needed. Never silently export the desktop's OAuth grant into a new server client. IMAP/SMTP secrets similarly remain in the owner's Integration credential vault. Mail read/write/send, Calendar write and optional shared access remain independent current capabilities. No application-wide Microsoft permissions or Google domain-wide delegation are implied.

## Replicas and conflict semantics

The hosted owner journal supplies a monotonic stream generation/sequence. Devices maintain a downloaded checkpoint and signed snapshot manifest. An obsolete or truncated stream requires an authenticated snapshot, then deltas. Immutable original MIME/parts retain their account-bound hashes; the local searchable projection is rebuilt in the encrypted local store. Snapshot import is a new replica protocol, not repeated invocation of the existing backup-restore operation, which intentionally quarantines authority.

Every offline control request carries its device ID, operation UUID, expected object generation/revision and provider/account binding. The owner service records that key and the exact input atomically. A replay with the same input returns the recorded result; a different payload under the same operation ID conflicts. Network arrival order, clock timestamps or an address match cannot overwrite a newer revision.

| Data/action | Conflict and offline rule |
| --- | --- |
| Read cache, original MIME, attachments | Immutable owner/account objects. Local offline reads continue without provider contact. Missing content stays missing until downloaded; no global search fallback. |
| Drafts and attachments | Local edits are immediately durable on the device. Upload against the base revision. Concurrent edits create a conflict/retained copy for review; no last-writer-wins loss or automatic recipient merge. |
| Read flags, labels and archive | Queue an intent against the observed provider precondition. Provider observations remain authoritative. A stale intent is reviewed, not blindly applied after refreshing. |
| Send and scheduled send | One canonical action and MIME/Message-ID snapshot. Offline creation is a local pending intent until the hosted journal acknowledges it. A local save is not a hosted delivery promise. Cancellation/rescheduling use compare-and-swap and cannot guarantee cancellation after dispatch. |
| Snooze | Remains device-local by default. Cross-device snooze requires a separate explicit migration to one owner journal, preserving conversation scope and generation/revision. A stale device cannot recreate an expired or cleared snooze. |
| Local rules | Remain device-local by default. Moving rules to the hosted owner requires explicit review, activation fences and disabling that device's runner for the transferred scope. Initial snapshots/backfills never become new arrivals. |
| Matter filing and assistant access | Always explicit and scoped to the owner's current account/workspace/directory/matter grant. A device/worker capability alone does not authorize search across matters or filing into a project. |
| Deletion, revocation and retention | Durable owner tombstones prevent a returning device from resurrecting deleted server state. Explain retention of existing exports, filings, backups and offline copies. Server deletion does not falsely promise immediate offline-device erasure. |

## Dispatch ownership and recovery

Choose one dispatch authority per owner/account, with a durable epoch and exact action IDs shared by devices and workers. In hosted mode the local client may prepare drafts and intents, but its provider-action runner cannot independently send the same scope. A send intent is acknowledged only after its encrypted MIME and journal commit durably. Preserve the existing fixed UTC instant/display zone and uncertain-outcome rules.

The provider gateway checks current account permissions and dispatch epoch immediately before each new external write. Workers must not keep a general provider token that lets a stale lease bypass that gateway. Store the exact attempt as dispatching before the external effect. Lease expiry cannot prove that an in-flight provider request did not succeed. A replacement worker leaves dispatched/unknown attempts uncertain and uses the existing read-only reconciliation path. It must not resend just because a lease expired, a pod restarted or a receipt was lost. This is not an exactly-once provider guarantee.

Do not implement automatic offline failover from hosted to local sending. Transfer authority only after a durable source stop, epoch change and acknowledgement, with in-flight/uncertain work retained for review. If the source is unreachable, disabling its future access is an explicit recovery operation, including credential revocation where necessary. Old actions stay uncertain; they do not become fresh local sends. Read-only offline access does not need this handoff.

Keep UTC clocks monitored, recheck due time at dispatch and preserve the current rollback guard. Always-on means the firm service can attempt work without a device; it still depends on service availability, quota, current consent and the provider. A reconnect or scope change fences stale reviews, agent proposals and rule activation. Operator restore starts paused, quarantines old work, disables rules and requires current account proof before enabling fresh actions.

In explicitly enabled hosted mode, device sleep, screen lock and local Email lock close that device's cache and keys; they must not silently pause or unpause the remote owner worker. A service-wide pause is a separate acknowledged, versioned owner/account intent. Do not forward today's desktop lifecycle messages as global remote pause commands. Disconnect in the existing Integrations account revokes its future worker access across the shared account services; signing one device out revokes that device capability rather than secretly disconnecting every device. Review these distinctions during hosted activation.

## Provider requirements and operating estimate

Provider facts were checked on 1 November 2026. Read the deployed project's actual console quotas before committing capacity; older Gmail projects may retain earlier limits.

- Google's new-project table lists 6,000 units/user/minute, 1,200,000/project/minute and an 80,000,000-unit daily billing threshold. Metadata/raw message GETs cost 20/60, history 2, labels 1, list 5, send 100 and modify 5. The daily threshold is not a hard rate limit or a published price. This model reserves 20% below each budget; it does not invent an overage rate. [Gmail quotas](https://developers.google.com/workspace/gmail/api/reference/quota).
- History expiration can require full recovery. Push is not a substitute for a cursor: Gmail watches need renewal at least every seven days, and notifications can be delayed/dropped. Hosted restricted-scope data also changes Google's verification/security-assessment requirements. These are launch gates, not benefits inherited from desktop qualification. [Sync](https://developers.google.com/workspace/gmail/api/guides/sync), [push](https://developers.google.com/workspace/gmail/api/guides/push), [scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
- Outlook limits include 10,000 requests/10 minutes and four concurrent requests per app/mailbox. Delta state is per folder. Shared/delegated change notifications require application permissions rather than the current delegated sharing scopes, so retain polling for that case unless a separate permission project is explicitly approved. No automatic permission escalation for push. [Limits](https://learn.microsoft.com/en-us/graph/throttling-limits), [delta](https://learn.microsoft.com/en-us/graph/delta-query-messages), [notifications](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview).
- Microsoft access-token lifetimes vary; refresh uses actual expiry, serialized rotation and current consent rather than an hourly timer. The model's 60-minute interval is a sizing assumption. Refresh can require user interaction after revocation or policy changes. [Access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens), [refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens). Google also requires the appropriate offline authorization/client registration for server use. [Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
- IMAP connection limits and authentication depend on the deployment. IDLE applies to a selected mailbox and needs renewal; it is not permission to hold unlimited connections or skip periodic reconciliation. [IMAP IDLE](https://www.rfc-editor.org/rfc/rfc2177.html).

The [reproducible model](../scripts/mail/hosted-capacity.mjs) and [inputs](mail-hosted-capacity-inputs.json) estimate the current polling design, not a hypothetical optimized hosted service. Assumptions: one account per user, 40/40/20% Gmail/Graph/IMAP, 20 GiB original MIME per account, mean 256 KiB/message (81,920 messages), 100 new messages and 20 metadata changes/day, five sends and twenty organization actions/day. Polling is every 60 seconds; Outlook has twenty folders and five hierarchy-list calls. A round includes folder metadata GETs and delta GETs, not just one mailbox delta call. Graph changed message keys conservatively count as raw redownloads with metadata/attachment checks. IMAP enumerates existing UID/internal-date rows even with CONDSTORE; IDLE does not remove that current scan.

The sizing inputs are explicit assumptions, not benchmark results: 160 MiB per owner worker plus 32 MiB/account, 2 GiB shared base memory, 0.1 ms/IMAP metadata row, 30 ms/message projection, 50% target CPU utilization, 30% RAM/storage headroom and 10% retry overhead. Original data plus a 25% projection allowance has two hosted data copies and one backup copy. Two full local replicas contribute to egress but do not grant a second person access. A second data copy does not imply a hot standby worker or tested failover.

These memory inputs describe steady residency, not a large-message peak or an enforced worker limit. Measure concurrent MIME/attachment buffers and proxy uploads before assigning memory limits. Storage is priced at the stated occupancy, not as a lifetime allowance; new mail grows it unless retention offsets that growth. Attachment-heavy projections can exceed the 25% assumption: a 100% overhead allowance multiplies storage and replica-transfer terms by 1.6. Use that sensitivity before committing a firm budget.

EUR arithmetic uses illustrative inputs, not vendor quotes: 0.04/vCPU-hour, 0.005/GiB-hour RAM, 0.03/GiB-month storage, 0.08/GiB device egress, sixteen operations hours/month at 90/hour and 50/month fixed service allowance. Operations is shared maintenance effort, not a staffed 24-hour on-call service. The output includes those hours and a 30-day month. Replace unit rates with the firm's actual infrastructure and labor costs.

<!-- mail-hosted-capacity:start -->
| Users | Gmail/Graph/IMAP | HTTP calls/month | IMAP metadata GiB/day | vCPU | RAM GiB | Hosted TiB | Gmail initial days at daily budget | EUR/month |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 25 | 10/10/5 | 23.19 M | 58.01 | 2.03 | 8.69 | 2.38 | 0.85 | 1657.02 |
| 100 | 40/40/20 | 92.75 M | 232.03 | 6.63 | 26.98 | 9.52 | 3.41 | 2086.79 |
| 500 | 200/200/100 | 463.76 M | 1160.16 | 31.17 | 124.48 | 47.61 | 17.63 | 4378.92 |
<!-- mail-hosted-capacity:end -->

The last column is steady monthly cost under those inputs. Initial device transfer is additional and appears separately in JSON. Provider overage charges, OAuth assessments, app approvals, mailbox licenses, a token broker's tariff, KMS/request charges, off-site backup transfer, repair bursts, OCR/semantic indexing, network ingress charges, hot standby compute and incident staffing are unpriced. The estimate is not a hosted-service quote or a launch qualification.

The Gmail initial-days column is a mathematical minimum under the chosen 80% daily-budget policy, including retry allowance, not an imposed provider delay or delivery promise. JSON also reports the independent minute-rate minimum and remaining concurrent backfill capacity. A null budget means the chosen fleet has no remaining headroom, not zero waiting time. The daily billing threshold must not be mistaken for a documented free unlimited API or silently exceeded without a cost policy.

At 500 users, the example's IMAP metadata alone exceeds 1 TiB/day. This is a direct consequence of the current rescan assumption, not measured network traffic. Improve dirty-folder reconciliation and measure MAIL-141 before offering always-on IMAP at that scale. Quantify Graph folder discovery caching, per-owner memory, encrypted writes, cursor expiry repairs and live quota use before replacing these CPU/memory assumptions. A tenfold change in per-row work changes the IMAP CPU term tenfold. The model deliberately makes those costs visible rather than claiming linear capacity from the desktop tests.

Use a fleet quota controller per provider project and mailbox, shared with other Integrations consumers. Reserve interactive writes ahead of bulk import, persist cooldown/backoff, respect `Retry-After`, stagger OAuth refreshes and add jitter after outages. Reading on several devices through the same provider project also consumes the same user's budget. Replica reads should consume the owner snapshot, not independently download the mailbox again. Webhooks are future hints with authenticated owner routing, renewal, deduplication and fallback reconciliation; they are not trusted message content.

## Work packages and release gates

Engineering estimate: 17-28 engineer-weeks for a reviewed pilot candidate, not a production date. These are planning ranges inferred from the missing boundaries above, not a measured velocity or supplier commitment. Provider/security approval lead time and waiting for firm test accounts are additional.

| Work package | Estimate | Evidence required before pilot |
| --- | ---: | --- |
| Authenticated owner registry, tenant/worker bootstrap and deployment identity | 2-3 weeks | Same account IDs/addresses in two tenants, replayed device enrollment and forged owner fields all deny cross-owner access. Current host token stays local. |
| Key custody, device enrollment/revocation and operator recovery | 3-5 weeks | Rotation/crash/restore drills across database, blobs and keys; explicit lost-device limits; no shared unwrapping secret. |
| Snapshot/delta replica protocol, offline search and conflict review | 4-6 weeks | Two-device offline edits, missing content, interrupted snapshots, stale checkpoints and deletion tombstones; no lost draft or automatic recipient merge. |
| Dispatch epoch, migration and scheduler handoff | 3-5 weeks | Process death and partition before/after dispatch, duplicate device UUIDs, stale leases, cancellation races, clock rollback and uncertain sends never replay. |
| Hosted provider/queue qualification and quota admission | 3-5 weeks | Gmail quota/repair load, Outlook shared mailbox permissions, IMAP reconnect/UIDVALIDITY, backfill/rules exclusion, latest lifecycle and multi-owner fairness on real authorized test accounts. |
| Operational deployment, alerts, portable export and rollback | 2-4 weeks | Measured cost envelope, staffed ownership, encrypted backup restore, provider revocation, local-only recovery and a rollback that cannot double-send. |

Implementation must also preserve local export of original EML/MBOX and supported archive formats, encrypted backups, account-scoped manifests and readable local drafts without the hosted service. Test export/import and current restore quarantine with the service unavailable. Reusing a hosted worker or sharing a project never implicitly shares a mailbox or grants another user's assistant access. A distinct, explicit provider/matter delegation remains necessary.

MAIL-163's scoping deliverables are complete in this document and the model. The implementation/pilot gates above are future work and have not passed. Create separately estimated implementation tickets only when a firm need, custody/region choice, current provider approvals, availability target and operating budget justify proceeding. MAIL-156 remains a prerequisite; MAIL-120/135/141/152/153/173 continue to own the applicable provider, performance, platform and release evidence.

## Reproduce the assessment

```sh
node --test scripts/mail/hosted-capacity.test.mjs
node scripts/mail/hosted-capacity.mjs
node scripts/mail/hosted-capacity.mjs --table
node scripts/mail/hosted-capacity.mjs --check
```

These commands are headless arithmetic and file checks. They read no mail or credentials and do not provision, connect or launch an app. Model tests check conservation, per-owner memory, budget exhaustion, polling sensitivity, replica transfer, cost totals and invalid inputs. They do not claim to test a future tenant-isolation or replica implementation.
