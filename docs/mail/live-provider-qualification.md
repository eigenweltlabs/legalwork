# Real-provider qualification — EIG-173

Evidence register, 12 September 2026. This is the current connection/sync qualification record; earlier EIG-120/135 registration and transport documents preserve implementation history. Configuration validation and synthetic transport tests do not certify a real provider. EIG-153 remains the wider release gate for failures, outbound behavior and platform coverage.

Latest result: **the read-only Google Workspace comparison passed** on macOS arm64 at `aa2dd5d8b`: 609 distinct messages, 14 labels, every message's memberships, and the selected 10 original/body and 17 attachment samples matched, with stable provider/local anchors and no retries. [Full aggregate evidence](evidence/gmail-qualification-2026-09-12-full-paced.json). This does not certify every advertised provider or every message's content; external account and live mutation gates remain below.

## Current evidence

| Advertised account type | Supported connection path | Live evidence on macOS arm64 | Remaining qualification / input |
|---|---|---|---|
| Gmail / Google Workspace | Settings → Mail → Google, desktop OAuth | Workspace account connected; independent 609 IDs, 14 labels and all 609 membership checks match; sampled 10 originals/10 bodies/17 attachments match with stable anchors. | Controlled incremental, offline/pause, expiry/revocation and authorized send-as/Sent-copy tests remain open; coordinated app reopen/read smoke succeeded. Consumer Gmail is not separately verified. |
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

Bounds: an abort deadline at 180 seconds per run (the slot remains occupied until cancelled physical requests settle); HTTP transport timeout 30 seconds; 20 enumeration pages of 500 IDs, caller maximum 10,000 messages; 10,000 local memberships, 10,000 labels and 50,000 content manifests; sequential metadata GET starts spaced at least 250 ms; 1–20 samples, 8 MiB each and 64 MiB total sampled raw bytes; 4 MiB stored body; 2,000 parts per sample. Oversized samples, changing provider history/local manifests, duplicate provider IDs, missing/incomplete projections, cancellation and limits cannot report a comparison match. A complete run can still report a mismatch. `state=complete` is operation completion, not provider certification; require `comparison=match` and inspect explicit coverage counts. Other providers are rejected by this diagnostic until separately implemented/qualified.

For EIG-173 acceptance, attach the actual aggregate result here, then coordinate an approved synthetic mailbox dataset for incremental arrival/read/unread/folder changes and send-as/Sent-copy cases. Token expiry/revocation, offline, pause and restart on the normal app require lead coordination. Missing accounts and unapproved mutation tests remain open, not synthetic passes.

## Current setup corrections

Mail account setup is in app Settings. Successful connections begin eligible sync automatically, and connected eligible sessions resume after reopen; Pause retains explicit user intent. SMTP is a separate Settings configuration for IMAP accounts, with implicit TLS or required STARTTLS. The IMAP retrieval connection itself currently requires implicit TLS. Send is enabled only through the durable outbox and verified sender identity/capability checks; an IMAP connection alone does not configure outbound access.

The current dedicated Microsoft registration supports organizational and personal Microsoft accounts with v2 tokens. Personal authorization uses `consumers`; organizational authorization remains pinned to the configured tenant. Historical tenant-only readiness text does not describe the current UI. See [registration setup](registration-setup.md) for the dated registration record. Public consent/verification/distribution prerequisites remain separate release work; no public legal notice was changed here.

## Focused implementation verification

`pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite runtime/qualification` passes 16 actual Node/encrypted SQLite cases: equal-byte distinct identities, exact raw/body/attachment reads without database writes, missing identities/membership mismatch, moving history and limit classification, physical cancellation/overlap including an abort-ignoring transport, credential disconnect, strict protocol redaction and job correlation. `pnpm exec bun test ./src/mail/qualification-routes.test.ts` from `apps/server` passes 1 route case / 10 assertions for host-only access, strict limits, unknown-field rejection, remote registration denial and cancellation of a disconnected start. These fixtures use synthetic provider responses and no real account credentials. Native runner compilation covers the affected worker/route graph; no full application/platform suite was run.

Transport drain follow-up: the unchanged normal transport deadline still returns promptly; diagnostic owners additionally await its tracked physical work before releasing their run slot. The affected Gmail transport plus qualification route suite passes 17 cases / 162 assertions, including its actual compiled Node transport fixture. An abort-ignoring synthetic fetch confirms a cancelled run rejects overlap until that fetch settles.

Completeness review: each sampled message also requires `MailReadStore.contentState=complete` and a complete current raw-bound `MimeProjectionStore` record. Matching raw/body/attachment bytes with unfinished enumeration or a failed projection increment `incompleteSamples` once per sample and cannot match. Fresh unsupported/malformed/limited MIME projections also increment this count; cancellation still propagates. The current parser returns only a supported projection or throws, with no warning-bearing partial success. Projection state and enumeration changes are included in the local stability fingerprint. Two dedicated regressions cover matching bytes with incomplete/error state and a fresh unsupported charset.

## First live comparison — incomplete, 12 September 2026

The lead ran the diagnostic on the normal macOS arm64 app at revision `9e0a20610` after a coordinated restart. [Exact aggregate result](evidence/gmail-qualification-2026-09-12-partial.json): all 609 distinct provider IDs matched 609 local IDs, all 14 label IDs matched, and the first 307 membership checks had zero mismatches. The run failed after 15.406 seconds before any raw/body/attachment samples or final provider/local stability anchors. This is **inconclusive**, not a completed manifest/hash qualification. The original `provider_failed` category cannot establish whether the cause was throttling, authorization, invalid provider metadata or a transient transport failure.

The reviewed follow-up adds only an allowlisted `transportCode`, validated nonnegative safe-integer `retryAfterMs` (or null), and `failedPhase`. Provider error descriptions, payloads, headers, account identifiers and tokens remain excluded. At that checkpoint no diagnostic auto-retry was enabled; the next lead-controlled run was required to establish the actual failure category. A typed rate-limit response can justify a later bounded, cancellation-aware backoff; quota exhaustion, authorization and invalid responses must not receive blanket retries. The aggregate record above is preserved unchanged rather than retroactively upgraded to a pass.

## Second live comparison — confirmed rate limit, 12 September 2026

The lead's [second unchanged aggregate report](evidence/gmail-qualification-2026-09-12-second.json), revision `72df4690f`, again matched 609 IDs and 14 labels. It checked 531 memberships with zero mismatches, then stopped after 27.241 seconds with `transportCode=rate_limited`, no Retry-After value, and no raw/body/attachment samples or final stability anchors. This remains **inconclusive**; the additional metadata coverage does not replace the missing samples/end anchors.

The next reviewed implementation uses one metadata request at a time, at least 250 ms between starts. Only the demonstrated `rate_limited` error (HTTP 429 or the transport's allowlisted Gmail rate-limit 403 classification) receives exponential 1/2/4-second backoff. A valid Retry-After is honored when longer. There are at most three retries per metadata operation and eight per diagnostic, all within the existing 180-second abort deadline. If Retry-After cannot fit, the run ends limited instead of retrying early. Cancellation interrupts pacing/backoff; the physical transport is drained before retry. Success counters advance only once per identity. `metadataRetries` reports actual retry attempts. Authorization, quota exhaustion, invalid response and other failure categories do not receive speculative retries. Original MIME consumption is never retried, so partially consumed sink chunks cannot be appended or replayed.

Focused regressions cover metadata start spacing, successful 429 recovery and once-only counts, Retry-After longer than the remaining deadline, cancellation during backoff, and no raw retry. Live execution remains lead-controlled after review; no third result is assumed here.

## Third live comparison and quota investigation — 12 September 2026

The [third unchanged report](evidence/gmail-qualification-2026-09-12-paced.json), revision `6c26f4a36`, matched 609 IDs/14 labels and 474 memberships with zero mismatches, but exhausted eight metadata retries after 89.060 seconds. It returned rate_limited, no Retry-After, and zero samples. This is still inconclusive; the retry budget was not increased.

Google's current [quota reference](https://developers.google.com/workspace/gmail/api/reference/quota) states that projects created from May 1, 2026 receive new quotas, while qualifying earlier active projects retain existing quotas. It lists 6,000 units/minute per user/project and 20 units per messages.get. The prior 150 ms cadence could therefore consume approximately 8,000 units/minute; that is a plausible explanation, not proof of the actual project's effective limit. The corrected 250 ms cadence uses approximately 4,800 units/minute before other clients/activity. The root should inspect effective Gmail API per-user and per-project quotas, existing overrides, project age/legacy eligibility and aggregate usage/error charts read-only; do not change quotas or print project credential configuration.

Google's [error guide](https://developers.google.com/workspace/gmail/api/guides/handle-errors) distinguishes userRateLimitExceeded from rateLimitExceeded and project dailyLimitExceeded. HTTP429 can also indicate user bandwidth or concurrent-request limits shared across clients. HTTP status alone does not identify the exhausted resource. The transport now exposes only numeric `httpStatus` and an exact allowlisted `providerReason`, including bounded parsing of 429 JSON. Unknown reasons, error messages, quota descriptors, project IDs and arbitrary detail payloads are discarded. A generic 429 without a known reason remains ambiguous; use aggregate console quota evidence instead of inferring an identity or limit from free-form text.

### Next root-controlled invocation

After review/integration, first run the same host endpoint with:

```json
{"action":"start","accountId":"<existing selected Gmail account>","mode":"samples","maxMessages":2000,"samples":10}
```

This still independently enumerates IDs/labels, then reads the bounded raw/body/attachment samples and final stability anchors. It issues no exhaustive minimal-metadata requests. `sampleComparison=match` means the sampled bytes/projections match with stable anchors; `comparison` remains `inconclusive` because memberships were intentionally omitted. Record the exact aggregate alongside the first three reports. A rate-limited sample-only run should stop for quota inspection, not trigger an automatic rerun loop.

Only after that result and effective quota inspection should the lead consider one `mode=full` run. Full mode now samples **before** the paced exhaustive membership phase, so a later quota failure retains real byte-comparison counts; without final stability anchors, even those counts do not become a completed sample verdict. Full mode requires every membership plus stable anchors to match. Both modes retain the same 180-second abort deadline, sample byte limits, no raw retry, physical cancellation ownership and bounded metadata retry budget. No resume/checkpoint subsystem or authorization loop was added.

## First sample-only live comparison — 12 September 2026

The [unchanged sample-only report](evidence/gmail-qualification-2026-09-12-samples.json) at revision `6e67849c0` completed in 2.746 seconds without throttling. IDs/labels again matched 609/14. Ten raw originals, fifteen attachments and nine body projections had zero byte/text mismatches; provider and local anchors were both stable. One sample was incomplete, so `sampleComparison` and full `comparison` correctly remained inconclusive. No memberships were requested in this mode.

The diagnostic now adds a fixed `incompleteReasons` count object distinguishing reader/projection state, missing raw/body, unavailable parts, stored body size limit, and unsupported/malformed/limited/other fresh projection failures. Counts can overlap for one sample; they contain no message IDs or private MIME values. The preceding report cannot retrospectively identify the reason. A no-displayable-body message is not inherently incomplete: an attachment-only synthetic MIME with a stored empty body envelope passes sampled comparison. The lead can run one further sample-only comparison to obtain the reason counters, without an exhaustive metadata run.

The root independently confirmed the published current quota table. Effective project quota inspection remains blocked because gcloud requires reauthentication; no new auth flow or quota/configuration change was performed.

## Production scheduler correction

Production GmailBackfill used serial requests but default zero turn delay, allowing fast raw downloads and minimal history snapshots to exceed the same quota. Its four messages.get call sites now share a per-engine/account monotonic 250 ms start gate, covering raw consumption, cached-original metadata refresh, untyped history snapshots and stale snapshot rereads. Existing durable cooldown, retry journals, cursor transactions and one-account execution semantics are retained. Session/job cancellation interrupts the gate; it does not launch work after Pause. This is a local rate ceiling, not a guarantee against shared project/user traffic from other clients or the diagnostic.

Focused actual-backfill evidence: six existing selected cases for initial raw completion, persisted throttling and untyped-history success/failure/pause/size caps pass; the new production pacing/pause case passes separately. The qualification suite passes sixteen native cases, including precise unsupported-projection counters and valid empty body envelopes. No live mailbox request was made by this implementation agent.

## Sample input-chunk correction — 12 September 2026

The [unchanged reason report](evidence/gmail-qualification-2026-09-12-sample-reasons.json), revision `23082d209`, again had ten matching raw originals, fifteen matching attachments and nine matching bodies with stable anchors; its only incomplete reason was `freshOther=1`. Code review identified a concrete diagnostic defect: projectMime accepts source chunks at most 65,536 bytes, but the diagnostic passed each entire original as one chunk. An original above that size therefore caused invalid_input despite a complete stored projection. The report remains inconclusive as observed; no real message contents were inspected to establish this code defect.

A shared bounded MIME-buffer iterator now supplies at most 64 KiB per parser chunk. The same scan found and fixed remote-draft conflict adoption, which also passed its entire raw buffer as one chunk. Ordinary stored-mail projection already streams through bounded content-store chunks; no other production projectMime call site used an unbounded whole-buffer array.

Three selected actual qualifier tests pass: >64 KiB multipart original with exact raw/body/attachment matches, unsupported input remaining incomplete, and a valid attachment-only empty body. Two actual draft runner tests pass: >64 KiB remote multipart adoption preserving attachment bytes and prior local history, and rejection of stale adoption after newer local edits. The lead may perform the next reviewed sample-only run to establish the corrected live result; none is assumed by this fix.

## Corrected live sample comparison — match, 12 September 2026

At revision `aa2dd5d8b`, the [corrected unchanged sample report](evidence/gmail-qualification-2026-09-12-samples-fixed.json) completed in 2.664 seconds. All 609 message IDs and 14 labels matched; 10 raw originals, 10 body projections and 17 attachments matched with zero mismatch/incomplete/oversize counts. Both provider and local anchors were stable, and there were no throttles/retries. `sampleComparison=match` is now supported by actual provider reads. Full comparison remains inconclusive because sample mode intentionally omitted memberships. The subsequent full membership run passed, as recorded below.

The earlier 15-attachment totals were incomplete coverage: the corrected parser completed the previously rejected original and compared two additional attachments. This does not indicate a provider attachment change. Counts are not an exhaustive byte inventory for all 609 messages, and the selected samples are not random. The same production parser is used for fresh projection; byte fidelity is independently checked against provider raw MIME, while MIME interpretation is covered separately by synthetic tests.

## Final read-only full comparison — match, 12 September 2026

The [full paced aggregate](evidence/gmail-qualification-2026-09-12-full-paced.json), revision `aa2dd5d8b`, completed in 155.726 seconds. Both `comparison` and `sampleComparison` are match. It compared all 609 provider IDs against 609 local IDs, all 14 labels, and every message's label memberships. Missing/extra/duplicate IDs, label mismatches and membership mismatches were zero. The same bounded content sample compared 10 originals, 10 body projections and 17 attachments with zero mismatch, incomplete or oversized sample counts. Provider/local anchors remained stable; metadata retries and transport failures were zero. No additional live comparisons are needed for this observed dataset.

This qualifies one Google Workspace account's read-only mirror at the observed point in time. It is not an exhaustive original/body/attachment hash manifest for all 609 messages, an independent MIME parser implementation, a random/statistical sample, or certification of controlled incremental changes and failure recovery. The account remained readable after coordinated app restarts; the lead separately confirmed the normal app retained its nine session turns. No email content was sent to a model by these diagnostics.

EIG-173's all-provider acceptance remains externally limited by the accounts in the matrix: personal Outlook account verification/connection; iCloud app-specific password connection; a licensed organizational Exchange mailbox plus shared/delegated rights; authorized Yahoo/Fastmail and explicitly named generic-host accounts; and an eligible configured Proton Bridge installation. Supply authentication only through approved local Settings/provider flows, never evidence files or issue text. Consumer Gmail also needs separate observation if advertised as separately certified.

Actual send-as/alias/on-behalf permissions, permission-denial behavior, delivery uncertainty and Sent-copy placement still require deliberate authorization and controlled synthetic recipients/data with the durable outbox. No live send/delete/move/mark-read, remote storage upload or model call was authorized or performed here. Windows/macOS x64 live provider accounts remain unverified even if separate synthetic platform gates pass. Public consent/registration distribution prerequisites and unmerged external storage providers remain separate dependencies. These gaps are retained explicitly rather than counted as synthetic passes.

## Scope-freeze acceptance reconciliation — 12 September 2026

The existing EIG-173 criteria remain unchanged. No further Gmail comparison, sign-in flow, live mutation or platform run was performed for this reconciliation.

| Original acceptance requirement | Current disposition |
|---|---|
| Inventory every advertised provider and explicitly identify missing coverage | Published above, including optional Proton Bridge and unnamed generic IMAP hosts. |
| Connect each provider through Settings and verify complete automatic historical sync | Observed for the supplied Workspace account only. Registration, named-but-unconnected accounts and synthetic transports do not satisfy other providers. |
| Compare provider identities/memberships and sampled message/attachment hashes | Workspace full read-only comparison passed at `aa2dd5d8b`: 609 identities, 14 labels, all 609 memberships, 10 originals, 10 body projections, 17 attachments. This is sampled content consistency using the production parser, not every stored body's independent certification. |
| Incremental arrivals, read/unread/folders, expiry/reconnect, offline, pause/resume and restart | Synthetic engine evidence exists in EIG-153. The live controlled sequence is still open; an ordinary app reopen is not that sequence. |
| Publish provider/platform/date/limits and fix demonstrated blockers | Matrix and dated aggregate reports retained; diagnostic large-chunk and quota/pacing blockers fixed. Missing providers remain unverified. |
| Real permitted aliases, shared/delegated SendAs/on-behalf, negative permissions and Sent-copy placement | Open. No authorized real send or controlled recipient was supplied. |

Required external inputs are concrete: the user must complete the already-requested Microsoft verification for the personal Outlook account; enter an iCloud app-specific password in Settings; provide a licensed Microsoft365 test tenant/mailbox and a real shared/delegated mailbox with declared permissions; and supply authorized Yahoo, Fastmail and explicitly named generic-host test accounts. Proton needs an available supported Bridge installation/account and its local connection/trust configuration if it remains advertised. Consumer Gmail requires its own account if advertised separately from Workspace. Credentials belong in the application's credential UI, never this report or chat.

For the remaining live behavior and identity scenarios, the lead also needs explicit authorization for a bounded synthetic mailbox dataset and named controlled send recipients, together with a coordinated window for offline/pause/restart and expiry/revocation exercises. No consent for ordinary account connection implies consent to send, delete, move or change read state during automation. Pending account inputs are external acceptance gates; they are not a reason to repeat the completed Gmail comparison or to invent additional implementation work. EIG-173 is therefore **not fully accepted** at the scope freeze.
