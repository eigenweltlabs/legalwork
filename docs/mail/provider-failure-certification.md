# Provider and failure-recovery certification — EIG-153

This is synthetic conformance evidence for the integrated mail backend, dated 2026-09-12. It is not live-provider or platform certification. The complete bounded provider/recovery matrix passes on macOS arm64 with actual Node 24.11.0 and native encrypted SQLite, schema 29. No live mailbox, real credential, provider mutation, model request, or running development application was used.

## Reproduce and identify the source

From the repository root:

```sh
pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite-set provider-recovery
pnpm exec bun test apps/server/src/mail/provider-config.test.ts apps/server/src/mail/providers/gmail.test.ts apps/server/src/mail/providers/development-config.test.ts apps/server/src/mail/providers/draft-adapter.test.ts apps/server/src/mail/mime/compose.test.ts
```

The native runner compiles production mail code once, runs the explicit 40-file manifest at `apps/server/scripts/mail-provider-suites.json` with concurrency 2, and removes its isolated temporary build and synthetic profiles. The tests use actual native encrypted database files and production engines; HTTP services are injected, while IMAP and SMTP wire scenarios use private localhost TLS fixtures. No production network endpoint is contacted.

The final run has **352 passing native cases, zero failures, cancellations, skips or todo cases**. The five additional contract files have **38 passing cases and 272 assertions**. The Gmail contract file also verifies compiled Node transport behavior; these numbers must not be added as independent provider acceptances. Full TAP output and contract output are retained under `certification/` beside this report.

Source baseline: integration `20dc922b8`, plus schema29 fix `45456a271` and the EIG-153 certification fixtures/runner in this delivery. The native run identifies the measured source with SHA-256 **7e9ae2fdac463c90ee2d0dc4ed6a1939205184d5a5bdacf7ada7f8d5db10119d**. The digest covers sorted mail source, tests and fixtures, the runner and suite manifest, and the two desktop maintenance/key-store modules copied by the runner; it does not identify the entire repository or a packaged application. Documentation/log additions do not change that digest. EIG-173 diagnostics integrated separately by root at `9e0a20610` are not part of this source digest or claimed coverage.

## Matrix and evidence boundaries

| Surface | Exercised behavior | Principal native fixtures |
| --- | --- | --- |
| Gmail | Full discovery including old mail; exact identities/memberships against a synthetic authoritative manifest; duplicate RFC Message-ID kept distinct; history replay, expired history and full reconciliation; missed membership/removal events; durable throttling/auth custody; offline exact originals, projected bodies and never-opened attachments after reopen | `providers/gmail-backfill`, `storage/gmail-history`, `storage/gmail-projection` |
| Microsoft Graph | Paginated folders/messages/attachments, immutable IDs and moves, duplicate RFC IDs, delta replay/current metadata checks, expired cursors, folder disappearance, interrupted pages, complete raw/body/direct attachment persistence; changed draft content invalidation; reference/protected content explicitly incomplete | `providers/graph-backfill`, `storage/graph-mailboxes` |
| IMAP | Actual TLS and certificate failures; LIST hierarchy/SPECIAL-USE, sparse/dense UID paging, INTERNALDATE, UIDVALIDITY reset before/during sync, missed events/polling, IDLE wake and CONDSTORE/QRESYNC, flags/expunges, complete bodies and attachments through service/worker and offline reopen | `providers/imap-backfill`, `providers/imap-incremental` |
| Mutations/conflicts | Stale versions and credentials, lost acknowledgments, native MOVE versus UIDPLUS fallback, scoped expunge, unsupported capability rejection before dispatch; durable journal/undo and draft replacement conflicts | `providers/http-actions`, `providers/http-action-runner`, `providers/imap-incremental`, `storage/action-journal`, `storage/draft-sync` |
| Outbound | Immutable queued MIME/draft pinning; no resend after accepted/uncertain restart; Gmail/Graph actual HTTP submission adapters and SMTP actual TLS DATA; lost acknowledgment, partial recipients, pre/post-dispatch cancellation, authorization recheck; zero/multiple/wrong-sender Sent candidates cannot settle an uncertain send, exact candidate can | `providers/outbound-recovery`, `providers/http-submit`, `providers/smtp-submit`, `providers/sent-copy`, `storage/outbox`, `storage/compose` |
| Crash/storage failure | Real SIGKILL before/after page and follow-up commits and during blob streaming; cursor/jobs/content atomicity; expired leases and fencing; actual SQLite page-limit `SQLITE_FULL`, no partial publication, preserved old content, durable retry and successful reopen | `storage/sync-journal`, `storage/content-store`, `storage/database`, `runtime/sync-executor` |
| Recovery/migration | Schema28 scope-index regression and schema29 transactional trigger repair; rollback, idempotent upgrade, reopen and FK/reference preservation; encrypted rekey/backup/restore, key isolation, disconnected credentials and quarantined pending/accepted/uncertain outbound work | `storage/extraction`, `storage/historical-upgrades`, `storage/maintenance`, `storage/recovery`, `storage/retention` |
| MIME/search completeness | Exact MIME streams, multipart and attached-message projection, malformed/protected/unsupported/oversized content remains explicit; extraction success/failure replay; account/source-version search scope and indexed attachment names | `mime/project`, `storage/extraction`, `storage/search` |

These are small deterministic corpora and bounded generated streams, not another large-mailbox benchmark. The new Gmail authoritative fixture starts with three messages, applies an addition/label change/deletion and replay, then expires history and independently changes the full manifest; four distinct originals are fetched exactly once. It compares the final present identity/membership set and all four retained original/body/attachment contents after offline reopen. Graph and IMAP use their checked-in provider-specific manifests and assertions; this is not a single universal provider inventory oracle.

## Defect found and repaired

The initial 39-suite run reported 346 cases: 340 passed and six failed. Three Graph completion/replay failures traced to a real production bug: an attachment manifest UPSERT invoked the old extraction trigger's `INSERT OR IGNORE`, but SQLite inherited the outer statement's conflict policy. Replaying an already known attachment raised a unique-key error and repeatedly failed MIME projection instead of completing.

Schema29 repairs the deployed schema28 insert/update triggers with explicit `ON CONFLICT (...) DO NOTHING`. Historical schema14 DDL remains historical; the migration repairs existing stores as well as fresh upgrades. A dedicated fixture reinstalls the exact old trigger, reproduces the unique-key failure, injects a DDL interruption, and verifies rollback. Successful migration preserves completed extraction text/results and unsupported/failed state on same-content replay. Changed attachment references queue new extraction while retaining historical references/results. Reopen and foreign-key checks pass. The sibling search-dirty trigger was inspected: production extraction uses ordinary UPDATE, and its existing-dirty-row finish/reset path passes; no speculative trigger rewrite was made.

The other three initial failures were stale fixtures: a Graph test tied credential throttling to an incidental fourth access call rather than the raw-job boundary; a compose test called the intentionally retired submission API; and a schema19 upgrade test left later outbox tables installed and hardcoded version20. The fixtures now exercise the intended boundaries/current APIs and existing downgrade helper. No failed cases were excluded to produce the final result.

The new disk-full case uses SQLite's actual `max_page_count` limit, not a thrown mock error. It verifies that a 2 MiB streamed replacement cannot acknowledge publication or erase existing content, and that the leased job is recovered and completes once after reopening with space available. This certifies SQLite allocation failure handling; it does not simulate every OS filesystem failure, full APFS volume, keychain failure or power-loss behavior.

The new outbound cases span queue → production runner/adapter → lost acknowledgment → encrypted database reopen → Sent reconciliation. Gmail/Graph responses are synthetic HTTP responses. SMTP DATA crosses real verified localhost TLS; Sent lookup uses an injected IMAP protocol fixture through the real Sent-copy implementation. An uncertain SMTP send never issues another DATA or APPEND. Separate existing Sent-copy cases cover configured copy behavior and ambiguous APPEND handling. Matching a Sent item establishes recorded submission evidence, not recipient delivery; state retains that distinction.

## Remaining acceptance gates

- **Live acceptance is still open in EIG-173.** Gmail Workspace observations and independent diagnostics belong to that report. This run does not certify Gmail personal, Outlook.com, Microsoft365/shared/delegated permissions, iCloud, Yahoo, Fastmail, a named generic IMAP server, or Proton Bridge against real accounts. Their credentials/test data/permissions must be supplied and tested under the separate authorization process.
- No real send/delete/move/mark-read/upload was authorized here. Provider-specific delivery, exact real Sent placement and enterprise policies therefore remain live gates. Synthetic generic IMAP conformance cannot establish every provider's behavior.
- Microsoft in-place archive, unavailable shared/delegated rights, protected/encrypted MIME and cloud reference attachments remain explicit capability exclusions or incomplete-content states; ordinary Archive folder support does not imply enterprise archive support. Unsupported IMAP MOVE/UIDPLUS operations remain rejected rather than guessed.
- EIG-152 owns Windows/macOS packaged application qualification, full application/platform suites and reference hardware performance. Those were deliberately not run. EIG-141's immutable 100k corpus/reports were retained untouched; the local matched warm-query result is not a 16 GiB reference-machine or Windows certification.
- The new disk-full fixture covers database allocation failure and existing crash fixtures cover process interruption; hardware power loss and arbitrary OS/filesystem fault combinations are untested. No claim of exhaustive failure-space proof is made.
- Shared file-storage provider branches and the separate LegalMemory deployment remain external dependencies. Passing local mail restore/search/scope checks does not certify those unmerged/deployed services.

No unresolved silent-loss or duplicate-send defect was observed in the exercised synthetic matrix. This conclusion is limited to the source and scenarios above; overall release/provider acceptance remains gated by the untested live and platform capabilities.

## Scope-freeze acceptance reconciliation — 12 September 2026

This records the current EIG-153 criteria without changing them or rerunning the matrix. The retained 352 native cases and 38 contract cases remain evidence for their recorded source baseline, not a claim that every later application change was re-certified by that run.

| Original acceptance requirement | Evidence and remaining boundary |
|---|---|
| Provider-visible manifests and sampled hashes after backfill, replay and full reconciliation | Synthetic authoritative/replay/reconciliation coverage is recorded above. The separate real Workspace backfill observation now passes: all 609 identities and memberships, 14 labels, sampled 10 originals/10 bodies/17 attachments. Real cross-provider replay/full-reconciliation qualification remains open through EIG-173. |
| Expired cursors, UIDVALIDITY resets, missed events, conflicts, disk full, throttling, revoked auth and crash checkpoints | Accepted synthetic production-engine/native/TLS evidence above. This does not claim real provider policy behavior or every filesystem/power-loss failure. |
| Offline old bodies and never-opened attachments; uncertain Gmail/Graph/SMTP sends | Accepted synthetic encrypted-reopen and production-adapter evidence above. No actual provider send, recipient delivery or real Sent-folder placement is inferred. |
| Publish capability results, exclusions and unresolved defects; reject silent loss/duplicate-send defects | Published matrix, source digest, complete raw logs and initial failure accounting retained. The demonstrated replay-trigger defect was repaired, not excluded. Missing live accounts and controlled outbound permissions remain explicit gates. |

The precise account and user inputs are listed in [EIG-173's acceptance reconciliation](live-provider-qualification.md#scope-freeze-acceptance-reconciliation--12-september-2026). No new live mailbox access, authentication, mutation, model call or repeated Gmail diagnostic was performed for this update. EIG-152 remains the authority for its separate desktop/package evidence; that evidence cannot substitute for provider qualification. EIG-153's documented synthetic criteria are complete, but its original full acceptance remains **open for the retained real-provider and authorized outbound gates**. Stop at these external dependencies rather than relabeling unverified providers as passed.
