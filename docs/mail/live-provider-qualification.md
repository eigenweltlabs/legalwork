# Real-provider qualification — EIG-173

Evidence register, 12 September 2026. This is the current connection/sync qualification record; earlier EIG-120/135 registration and transport documents preserve implementation history. Configuration validation and synthetic transport tests do not certify a real provider. EIG-153 remains the wider release gate for failures, outbound behavior and platform coverage.

## Current evidence

| Advertised account type | Supported connection path | Live evidence on macOS arm64 | Remaining qualification / input |
|---|---|---|---|
| Gmail / Google Workspace | Settings → Mail → Google, desktop OAuth | Workspace account connected; lead observed 609 complete original/body projections, 0 pending/failed. These are client counts only. | Independent manifest/hash diagnostic pending; incremental/restart/refresh/failure and authorized send-as/Sent-copy tests remain open. Consumer Gmail is not separately verified. |
| Personal Outlook / Hotmail | Settings → Mail → personal Microsoft, consumers authority | Registration audience and v2 desktop redirect verified; real mailbox sync not verified. | Lead owns ongoing account verification and app connection diagnosis. Do not start a second sign-in flow. |
| Microsoft 365 organizational | Settings → Mail → organizational Microsoft, configured tenant | No real mailbox supplied. | Licensed Exchange Online test mailbox, permitted consent, tenant/admin contact and controlled test recipient. |
| Microsoft shared / delegated | Explicit child mailbox and declared capabilities under organizational account | Synthetic scope/permission and immutable identity tests only. | Parent tenant mailbox plus real shared/delegated access; independently test ReadWrite.Shared, SendAs/on-behalf and Sent copies. Declared rights are not server verification. |
| iCloud | Fixed `imap.mail.me.com:993`, validated implicit TLS; separate SMTP Settings | Named user account available but not connected. | User-generated app-specific password entered in Settings by the lead/user; no password in issue, chat, logs or evidence. |
| Yahoo | Manual IMAP plus separate SMTP configuration | No real account supplied. | Authorized test account, provider-approved app authentication and current exact server settings. |
| Fastmail | Manual IMAP plus separate SMTP configuration | No real account supplied. | Authorized test account/app password with required mail permissions and current server settings. |
| Selected generic IMAP hosts | Explicit host/port/user/folders; validated implicit TLS | Synthetic protocol evidence only; no named host qualified. | Name each target host and provide its authorized account/configuration. Do not claim universal IMAP interoperability. |
| Proton Bridge | Optional qualification target in scope | No Bridge installation/account/certificate qualification; not certified. | Supported Bridge installation/plan, generated local credentials and explicit TLS trust configuration supported by the client. Plaintext IMAP and arbitrary certificate bypass are not supported. |

Windows and macOS x64 live provider behavior are unverified in this record. No live send, deletion, read-state change, move, remote upload or model request was performed for this diagnostic work. External storage PRs 131/137/138/139 are separate open integration/qualification dependencies; a mail attachment save contract is not live storage certification.

## Read-only Gmail comparison

The host-only `POST /mail/v1/qualification` control uses the existing authenticated loopback route and encrypted worker credential custody. It is unavailable to remote hosts and agent capabilities. It starts a memory-only background operation so ordinary HTTP/worker request deadlines cannot leave a long synchronous request with an ambiguous completion. Only one run may be active; cancellation retains its slot until pending requests settle. Global pause, account sync pause, disconnect and worker shutdown cancel it. No mail journal, message, label or body is written. Ordinary OAuth refresh can still update credential custody when necessary.

The lead invokes it through the current app's existing authenticated local connection, never by printing/copying a host token or provider token. Start body:

```json
{"action":"start","accountId":"<selected connected Gmail account>","maxMessages":2000,"samples":10}
```

Poll the returned job UUID with `{"action":"read","id":"<job UUID>"}`; explicitly stop with `{"action":"cancel","id":"<job UUID>"}`. Poll around once per second. An app restart drops the report and stops the diagnostic; it never resumes automatically. Record only the aggregate JSON report with date, platform, app revision and account type. Do not record provider IDs, subjects, addresses, MIME or credentials. The normal app and live requests are coordinated by the lead while other provider sign-in is in progress.

The independent provider enumeration includes Spam and Trash, counts distinct Gmail IDs rather than RFC Message-ID or byte hashes, and compares all returned label memberships and label IDs against the local mirror. Equal MIME messages with different Gmail IDs remain separate. Samples prioritize oldest locally dated attachment-bearing messages, then oldest other originals; the report is not random sampling or exhaustive attachment certification. Every sampled original and attachment is hashed from actual stored bytes and independently fetched provider raw MIME; stored body text is compared with a fresh projection of that raw MIME. The parser is the same production parser, so this is transport/storage fidelity evidence, not independent MIME parser correctness. Samples do not require opening messages in the UI.

Bounds: 180 seconds per run; HTTP transport timeout 30 seconds; 20 enumeration pages of 500 IDs, caller maximum 10,000 messages; 10,000 local memberships, 10,000 labels and 50,000 content manifests; four concurrent metadata GETs; 1–20 samples, 8 MiB each and 64 MiB total sampled raw bytes; 4 MiB stored body; 2,000 parts per sample. Oversized samples, changing provider history/local manifests, duplicate provider IDs, missing/incomplete projections, cancellation and limits cannot report a comparison match. A complete run can still report a mismatch. `state=complete` is operation completion, not provider certification; require `comparison=match` and inspect explicit coverage counts. Other providers are rejected by this diagnostic until separately implemented/qualified.

For EIG-173 acceptance, attach the actual aggregate result here, then coordinate an approved synthetic mailbox dataset for incremental arrival/read/unread/folder changes and send-as/Sent-copy cases. Token expiry/revocation, offline, pause and restart on the normal app require lead coordination. Missing accounts and unapproved mutation tests remain open, not synthetic passes.

## Current setup corrections

Mail account setup is in app Settings. Successful connections begin eligible sync automatically, and connected eligible sessions resume after reopen; Pause retains explicit user intent. SMTP is a separate Settings configuration for IMAP accounts, with implicit TLS or required STARTTLS. The IMAP retrieval connection itself currently requires implicit TLS. Send is enabled only through the durable outbox and verified sender identity/capability checks; an IMAP connection alone does not configure outbound access.

The current dedicated Microsoft registration supports organizational and personal Microsoft accounts with v2 tokens. Personal authorization uses `consumers`; organizational authorization remains pinned to the configured tenant. Historical tenant-only readiness text does not describe the current UI. See [registration setup](registration-setup.md) for the dated registration record. Public consent/verification/distribution prerequisites remain separate release work; no public legal notice was changed here.

## Focused implementation verification

`pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite runtime/qualification` passes 5 actual Node/encrypted SQLite cases: equal-byte distinct identities, exact raw/body/attachment reads without database writes, missing identities/membership mismatch, moving history and limit classification, physical cancellation/overlap, credential disconnect, strict protocol redaction and job correlation. `pnpm exec bun test ./src/mail/qualification-routes.test.ts` from `apps/server` passes 1 route case / 10 assertions for host-only access, strict limits, unknown-field rejection, remote registration denial and cancellation of a disconnected start. These fixtures use synthetic provider responses and no real account credentials. Native runner compilation covers the affected worker/route graph; no full application/platform suite was run.
