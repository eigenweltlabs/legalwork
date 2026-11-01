# Email release readiness and operations

MAIL-156 engineering checkpoint, 1 November 2026. PR [#130](https://github.com/eigenweltlabs/legalwork/pull/130) remains a draft. Release approval, live provider qualification and the private pilot remain open. Nothing in this document authorizes publication or declares those gates passed.

## User documentation

The bundled [Email guide](user-guide/email.md) covers the global navigation rail, shared Integrations setup and write consent, other IMAP/SMTP services, download limitations, local privacy, composition, invitations, scheduled send, snooze, rules, encrypted backup/restore, retention/removal and diagnostics. The [screen map](user-guide/screens.md) and `legalwork-help` routing identify the same controls. Technical notes accompany [scheduled send](mail-scheduling.md), [snooze](mail-snooze.md) and [local rules](mail-local-rules.md).

## Capability and evidence matrix

Implementation, historical observations and current release qualification are separate columns. A connected OAuth application or synthetic transport test does not establish live provider conformance.

| Provider/capability | Implemented path | Evidence and remaining release gate |
| --- | --- | --- |
| Gmail / Workspace | Native Gmail Integrations account, labels/history, original MIME, drafts and Outbox | MAIL-173 records a 22 September read-only comparison of 766 identities/memberships, 14 labels and sampled content. That historical checkpoint is not a current-head live rerun. Controlled changes, permissions, aliases and Sent-copy acceptance remain open. |
| Microsoft 365 / personal Outlook | Shared Microsoft Integrations identity, Graph immutable IDs/delta, drafts, sending, optional shared-mailbox permissions | Headless Graph and permission cases exist. MAIL-120/173 still require personal Outlook verification and a licensed enterprise/shared-mailbox test environment with declared rights. Do not advertise live qualification. |
| iCloud, Yahoo, Fastmail, selected generic hosts | Direct TLS IMAP with separately configured SMTP in Integrations | Implementation exists. MAIL-135 still requires actual eligible accounts and two named pilot hosts; IMAP access cannot certify SMTP or alias rights. |
| Proton Mail | No qualified Bridge path | [MAIL-136 qualification checkpoint](mail-proton-bridge-qualification.md) records the certificate trust gap and generic transport evidence. Actual Bridge setup, large attachments, send/restart/outage acceptance remains open. |
| JMAP / on-premises EWS | Follow-on assessment and bounded synthetic JMAP probe | [MAIL-160 assessment](mail-additional-protocol-evaluation.md); no native adapter is registered. Customer demand and authorized live configuration evidence remain open. |
| Protected mail | Preserve supplied originals; ordinary detached clear text can be read without signature verification | [MAIL-157 assessment](mail-protected-content-evaluation.md); no signer, decryptor, certificate import or Microsoft content-license enforcement. Genuine Microsoft protected-content interoperability remains open. |
| Meeting invitations | Downloaded ICS previews and reviewed replies through existing Google/Outlook Calendar accounts | MAIL-159 retains live interoperability and visual/keyboard acceptance. No automatic event import or full calendar-client parity is claimed. |
| Local rules, scheduled send and snooze | Account-scoped local implementation using existing journals and encrypted storage | Headless coverage exists. MAIL-161/195 retain their applicable review gates. No provider-server rules, cloud timed-send or cross-device local state is claimed. |
| Semantic search / multiple devices / hosted workers | Lexical search and local data remain current behavior | [MAIL-162 processing/evaluation contract](mail-semantic-retrieval-evaluation.md) defines consent and scope requirements; private retrieval measurement and semantic isolation remain open. [MAIL-163 scope](mail-multi-device-scope.md) is complete as an architecture/capacity assessment; no hosted runtime or replica sync is enabled. |

Current local validation is headless macOS arm64 development evidence. MAIL-152 retains the supported-desktop release matrix, including signed installation/update/reinstall, retained data, real OS lifecycle and Windows signing gates. Older successful substeps do not certify this integrated head or an entire workflow. For example, the historical [Windows/Intel qualification run](https://github.com/eigenweltlabs/legalwork/actions/runs/35711112952) and [signed first-open diagnostic run](https://github.com/eigenweltlabs/legalwork/actions/runs/35721951626) are both terminal **failure** at workflow level. MAIL-152 records their narrower evidence, subsequent fixes and remaining manual gates. Neither is presented as a green release run here.

MAIL-141's 100,000-message/reference-machine qualification remains deferred until the build/fix work is complete and its actual hardware/platform gates can run. The diagnostic counts added here are not that benchmark.

## Staged rollout control

The desktop host reads `LEGALWORK_EMAIL_CLIENT_ENABLED` when starting its embedded server:

| Host environment | Local Email client |
| --- | --- |
| Unset or `1` | Existing behavior, eligible only on the local desktop host |
| `0`, empty or another value | Disabled for that host start |

With the switch disabled, the host creates no local Email service, notification controller or badge binding and does not auto-unlock or migrate its store. Local Email routes are absent. Existing files, wrapped keys and Integrations accounts remain in place. Set `1` or remove the variable and restart the app to re-enable using a compatible build. This is an operator startup control, not a remote entitlement service or an in-session cancellation mechanism. The normal development profile remains unchanged by default.

Scope matters: the switch controls the local Email client and its background worker. It does not disconnect Gmail/Outlook integrations, revoke their provider permissions or disable independent assistant connector tools. Use their existing activation/write controls for that scope. Stopping a process cannot recall an already accepted send; any interrupted dispatch needs reconciliation.

Proposed stages remain gated:

1. Internal development: headless contracts, review and synthetic data. Keep PR draft while release blockers remain.
2. Named private cohort: only after provider/platform/security readiness, declared allowed data/actions and named support/release owners. MAIL-155 requires 2-3 willing firms/users and at least two working weeks of real workflow observation. No invitations, enrollment or pilot start happened in this checkpoint.
3. Wider pre-release: a recorded internal decision must name the exact commit, compatible platforms/providers, remaining limits, rollback owner and incident contact. Publish only through the existing [release-channel workflow](release-channels.md).
4. General release: promote only the capabilities justified by final evidence. A follow-on protocol or a completed design assessment is not a release capability.

## Safe containment and recovery

For a suspected data-loss, unauthorized-access or wrong/duplicate-send incident, stop expansion and record the affected build/platform and time. In **Settings > Mail accounts > Notifications > Background mail**, choose **Pause mail** where available, then lock/close Email. Pausing is not a promise that an already dispatched provider operation was cancelled. For the next host start, use the startup switch above to keep the local worker disabled. Avoid opening an older build against a newly upgraded live store.

Collect the aggregate report before disabling routes when practical. Preserve the encrypted source store and a verified encrypted backup with its separately held recovery passphrase. Never delete or replace the source to make a test pass. A runtime flag does not downgrade the database schema.

Prefer a corrected compatible build on the existing store. If restoration is required, follow the guide's explicit replacement and verification steps. The restored generation removes credentials and quarantines pending sends/draft mappings/file jobs; rules stay disabled. Reconnect and create new reviewed work only after verifying the restored state. For a code downgrade, use a separate backup known compatible with that older schema and retain the newer generation for recovery. Do not reinterpret a successful startup as proof that all data or sends are safe.

## Mail incident runbook

Use **Settings > Mail accounts > Data & access > Diagnostics > Export diagnostics** for the first support artifact. Review it and share only with the agreed recipient. The report is a strict aggregate allowlist, requires the local host token and reads the owner-scoped encrypted worker only when already ready. It makes no provider request, send, retry, unlock or repair. No account/message IDs, names, addresses, subjects, bodies, attachments, paths, cursor strings, credentials or raw errors enter the report. Counts themselves can still be sensitive. Nothing uploads automatically.

| Symptom / report evidence | Investigation and next action |
| --- | --- |
| Locked/unavailable state and no snapshot | Inspect the local app/runtime and unlock state through its normal controls. Absence of a snapshot means unknown counts, not an empty or repaired mailbox. Never ask for a wrapped key or recovery secret in an issue. |
| Pending originals, incomplete attachment enumeration or unavailable parts | Review account sync progress and fixed errors. Distinguish provider exclusions, inaccessible/protected content, throttling, storage failure and unfinished work. Obtain a controlled provider comparison before claiming content loss or completeness. |
| Queued/retrying jobs or overdue schedules | Check pause, screen lock, sleep, connectivity and account permissions. Due time is an earliest attempt. Review permanent errors in Outbox; do not bypass its snapshot/version checks. |
| Uncertain submissions or invitation replies | Preserve the journal. Use the existing acceptance/reply check, which only reads provider evidence. Verify the provider's outcome before creating any new attempt. Never automatically replay an uncertain action, including after restore or a downgrade. |
| Failed provider mutations | Review current write consent, identity and observed version. A fresh view and deliberate new request are required after conflict; a report does not grant rights or reapply changes. |
| Search pending or stale results | Check local download/projection/index progress. Lexical indexing is separate from original completeness. Preserve originals; do not delete the mailbox cache to rebuild an index. |

The report counts current local identities/manifests and retained journal rows, not unique RFC Message-IDs or a verified remote mailbox. Attachment counts cover observed manifests; unenumerated attachments remain unknown. Schedules count only queued/retrying scheduled submissions. Search counts describe local documents and dirty entries. Historical succeeded/failed action totals may remain until their normal retention lifecycle changes them. Stored counts do not recompute content hashes or certify exports.

General **Support logs** and technical diagnostics can include tool arguments/results, document excerpts and paths. They are a different, broader artifact and require explicit review before sharing. Do not substitute them for this aggregate mail report or attach a raw database/MIME/key/token to an issue by default.

Record each incident with a redacted reproduction, affected build/platform/provider family, local counts/fixed states, authorized test scope, outcome, owner and follow-up. Keep mailbox identities and raw source material in the agreed private channel. Assign release blockers for observed data loss, unauthorized disclosure, wrong recipient, duplicate send or incorrect replay of an uncertain action. Other feedback is triaged against core requirements and the explicitly bounded follow-ons.

## Open release decision

Follow-on priority remains: finish the existing invitation/rules/Outbox review gates (MAIL-159/161/195), then qualify protected-mail requirements against genuine authorized material (MAIL-157). Native protocols (MAIL-160), permission-scoped semantic search (MAIL-162), and firm-hosted/multi-device implementation after the completed MAIL-163 scope are demand-gated. They do not replace unfinished core provider, desktop, performance or pilot acceptance. No full Outlook parity is on offer.

MAIL-156 stays In Progress. The documentation and operator controls above are implemented; release is unapproved. MAIL-120/135/136/173 live provider inputs, MAIL-141 performance qualification, MAIL-152 desktop lifecycle/signing, MAIL-153 final integrated acceptance and MAIL-155's actual pilot remain open. MAIL-159/161/195 review gates are not automatically waived by passing headless tests. MAIL-154's existing review does not certify every later change by association.

Before release, record the exact candidate/evidence, unresolved critical/high defect audit, tested support matrix, permitted processing and published privacy state, approval owners and the explicit internal go/no-go decision. This checkpoint records **no release decision** and enables no distribution or provider approval submission.
