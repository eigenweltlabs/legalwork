# SaaS DD session audit — 30 September 2026, 16:46–16:58 Berlin

The **SaaS DD on data room** session produced a useful 26-page draft, but its claim of completed diligence is inaccurate. The native Customer Agreements review never started, all ten customer contracts were sent through the supplier MSA library, and twelve uncertainty dispositions fail a literal source/page check. The major financial exposures are substantially captured; source support, cross-document completeness and some legal conclusions still need correction.

This audit preserves the original report and registers. It used the existing dev Electron/profile, saved jobs, source files and programmatic checks. No screenshots, visual review or new inference were performed. The presenter’s answer key was used only for this post-run audit, never supplied to the workflow.

## Observed scope and execution

- Session: `ses_f0d37d3e8ffeprmOAOdKX1j41c`, exact title **SaaS DD on data room**.
- All 200 source PDF hashes still match the test corpus. Screening retained 29 bilateral agreements, five resolutions and six initially uncertain employment agreements; 160 operational records were excluded. The six uncertainties were retained and source-inspected.
- Classification preserved all 40 legal records and routed corporate agreements/resolutions correctly. However, its question defined only the corporate distinction, leaving Customer Agreements versus MSAs ambiguous. All ten SaaS subscription agreements received a confident MSA classification.
- The run made 84 tool calls: 11 corpus calls but only two new jobs, six launch attempts, one collective wait, six review exports, 14 reads, two globs, 28 shell commands and one script write. The other corpus calls read saved jobs/evidence rather than repeating inference.
- Nonempty reviews started on launch. DPA started at 16:48:10; MSA/employment overlapped at 16:48:16; corporate/resolutions started at 16:49:07/08. Immediate start and multi-review waiting worked. The later corporate starts leave further scheduling efficiency available.

| Native library | Actual documents | Cells processed | Needs review | Result |
| --- | ---: | ---: | ---: | --- |
| Customer Agreements | 0 | 0 | 0 | Draft; start failed with `review_no_documents` |
| Data Processing Agreements | 8 | 64 | 7 | Settled |
| Master Services Agreements | 16 | 128 | 25 | Settled; includes ten misrouted customers |
| Employment Agreements | 6 | 48 | 3 | Settled |
| Corporate Agreements | 5 | 40 | 6 | Settled |
| Shareholder Resolutions | 5 | 40 | 8 | Settled |
| Total | 40 | 320 | 49 | Five processed libraries; zero inference-error cells |

The apparent “review failed” was an empty selection/start, not a Jev provider failure. The old launch tool created the draft before discovering this; the agent ignored `ok: false`, exported the empty review successfully, and claimed six dedicated completed reviews. Matching the expected total of 320 cells did not detect the wrong-library coverage. The report even described customer contracts as part of the MSA workstream without repairing it.

The final plan still had report drafting/verification marked `in_progress`. Native completion, report verification and final todo completion need one consistent completion decision.

## Disappearing plan

The plan was stored through `setQueryData` and observed through an external cache subscription, leaving the TanStack query with zero observers. Its 15-second garbage-collection timer removed it after each update. This explains the brief appearance, disappearance and later reappearance with progress updates.

Todo entries now use infinite cache lifetime and explicit session cleanup. An existing shared client is retained during dev hot updates, old todo GC timers are cancelled, and the selected session’s plan is rehydrated with a race-safe read. The collapsible plan stays visible while a nonblank item remains unfinished, including idle/error/approval states, and disappears on completed/cancelled plans. Tests cross the real old 15-second deadline and simulate an already scheduled timer during a hot update.

## Recurring 413 and internal notes

The engine/provider error at 16:57:57 matches the paid gateway’s nginx log: the request was **1,049,475 bytes**, exceeding the default 1 MiB allowance by **899 bytes**. There is no tool-count-limit error in this trace. The request grew during source inspection, register/script generation and compaction. [nginx documents the 1 MiB default](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).

The paid ingress now allows 16 MiB and returns structured JSON on overflow. This remains below [Cloud Run’s 32 MiB HTTP/1 request cap](https://docs.cloud.google.com/run/quotas). The real ingress image accepted the exact failing size and 4 MiB with a local mock; 16 MiB + 1 byte returned JSON 413. Unauthenticated production probes at accepted sizes reached authentication (401), proving passage through nginx without paid inference. Overflow returned `request_too_large`. The nginx-only deployment preserved the other container/settings; the persisted fix is in [model-api PR65](https://github.com/eigenweltlabs/model-api/pull/65), whose four CI checks passed.

LegalWork renders request-size errors as short recovery guidance instead of HTML. Persisted and live assistant messages marked `summary: true` retain that metadata and are excluded from rendered conversation groups. They remain available to engine history. A compaction-summary `finish: stop` no longer marks an ongoing run idle. The screenshot’s “Objective / Important Details” text is such an internal summary.

## Report quality

The original Word output was already saved in project `reports/`. The session’s successful `document.read_draft` result reports **26 pages** for this report at draft revision 0. No visual layout review was performed. Zero template placeholders remain.

Improvements over earlier runs: the founder IP carve-out and EUR 43,000 employee payment are captured, the corporate/resolution split is correct, customer change-of-control ARR is EUR 535,200, convenience-exit ARR is EUR 435,600, and total customer ARR is EUR 1,758,000. These amounts match the original sources. Five apparently unsigned counterparties are correctly identified. The sixteen findings each have a valid primary-source hash and quotation/page.

Outstanding defects:

1. **Wrong-library coverage:** ten customers lack the intended customer-library analysis. An ad hoc source read is not equivalent to running and reconciling that library.
2. **Unverified dispositions:** all 49 native exception keys have one disposition, with no duplicate/missing keys, but only 37 supporting passages match their cited page. Twelve do not. Three operative-status entries and five lock-in entries contain assessments presented as quotations; three execution entries use generic resolution wording, including a DPA and a supplier MSA; one approval quotation reverses the source passage order around an ellipsis. These cannot support “every low-confidence cell was resolved from verified text.” All hashes match; a correct hash alone does not validate the passage.
3. **Incomplete aggregate citations:** the two-source customer termination finding has only one source citation, and the five-source execution finding has only one. The new validator reports five missing per-source citations. Independent source inspection confirms the substantive unsigned count, but the delivered register does not fully evidence it.
4. **Incorrect user count:** the customer section says 989 authorised users; the ten source agreements total **1,125**.
5. **Incomplete family reconciliation:** only one customer/DPA pair has matching supplied references. Nine customers refer to DPAs absent under the stated reference; seven DPAs refer to primary customer agreements absent under the stated reference. The report identifies only three unmatched DPAs. This is a supplied-evidence gap, not proof that agreements do not exist.
6. **Wrong non-compete conclusion:** the report says an employee can enforce a covenant with no compensation promise and demand compensation. This confuses nullity with a merely non-binding covenant. [BAG 10 AZR 448/15](https://www.bundesarbeitsgericht.de/entscheidung/10-azr-448-15/) addresses that distinction. The recommendation to waive solely to eliminate compensation claims is therefore unsupported.
7. **Weak DPA advice:** the seven-day processor breach notice is treated chiefly as commercial friction; [GDPR Article 33(2)](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) requires notice without undue delay. Recommending generic 48-hour standardisation would also relax several existing 24-hour commitments. Transfer-module selection and categorical legal conclusions need a separate supported assessment.
8. **Writing/identity:** technical method/model/settings details still appear in the legal report, and findings repeat across class sections, risk tables and actions. “LegalWork Advisory” and the assertion of attorney-client privilege lack a supplied basis. These instructions were already present but were not followed reliably.

The original draft and its evidence records have not been silently rewritten. Citation diagnostics and a concise source-facts audit are saved separately alongside this audit.

## Command audit and supplied replacements

This run wrote **one** approximately 49 KB report-building script, not sixteen script files. Its 28 shell commands still caused avoidable context expansion and mistakes:

- Package probing and failed `pypdf` imports, then guessed CSV headers, preceded an already available native evidence path.
- Printing the first lines of all 40 PDFs returned 47,613 characters; subsequent class dumps repeated large portions of the sources.
- Template/table/token/style probes repeated several times. Findings/dispositions were hardcoded into long shell strings, causing quoting/syntax retries.
- The 22 KB UI action catalogue was fetched just to discover a known action.
- The full document read for page count generated over 62 KB and was truncated.

Changes supplied for the next run:

- `legalwork_jev_evidence_export` writes original page-labelled passages and a compact title/classification index from a saved job directly to project files. Its actual 40-source export produced 40 evidence files; hashes and page text all match the original sources. It performs no new inference and does not clear uncertainties.
- Empty selections are rejected before creating a review. Empty/draft review exports are rejected rather than presenting successful zero coverage. Actual saved empty-review export was rejected in the running app.
- All six classification roles are defined, especially target-as-seller customer contracts versus target-as-buyer supplier MSAs. The skill requires source-index reconciliation before launch and repair of mismatches using saved subsets.
- A supplied template-population helper consumes JSON and preserves template runs, artwork and repeated rows, avoiding a bespoke Word-building program. It was exercised on formatted split tokens, repeated rows, headers, missing fields, overwrite protection and the actual Eigenwelt template; style/media preservation was checked programmatically.
- A supplied evidence verifier checks current hashes, exact page quotations, ordered omissions and per-file aggregate support. It writes diagnostics and prints counts. It correctly rejects twelve original disposition passages and five missing aggregate citations. Seven regression tests cover real failure modes, changed sources and project-boundary protection. Literal support is not legal clearance.
- `document.read_metadata` exposes name, revision, save state and actual page count without serializing the report. The skill calls it directly for delivery checks.
- The final answer instruction is now a maximum of four short sentences: a plain-language executive-summary synopsis and report link. It excludes document/register codes, technical methodology, findings inventories and supporting-file catalogues. Progress updates stay short. Completion requires review/library/source reconciliation, evidence checks and final todo completion.

The installed skill and all portable active skill copies/packages include the updated rules and helpers. Generic Word helpers are also embedded in the generated bundled-core manifest. Original corpus/operator/legacy QA assets are preserved.

## Scale: 5,000 files versus 5,000 agreements

Saved `sourceSelection={jobId,answers}` already transfers large classes internally without generating 800 file IDs in a model call. A 6,001-source selector regression exists. Compact overview/result filters, direct native exports, evidence files and short metadata reads now remove major context amplification. Class summaries should be durable, source-cited orientation records; retain detailed facts/dispositions on disk and read targeted exceptions rather than all contracts or the entire draft repeatedly.

The 5,000-file demo contains 800 legal records; **5,000 legal agreements** is a substantially larger case. End-to-end execution of either full corpus was not performed here. Large-class execution still has a 64 MiB saved-review JSON read limit and full snapshot rewrites per cell update; a single 5,000-agreement/eight-column review can exceed the observed storage allowance. Incremental persistence remains necessary. Saved-source export is compact in model context, but a huge evidence export still needs background progress/resume semantics for reliable long jobs.

A further product gap is a typed, citation-backed fact ledger with deterministic aggregation and cross-document relationship checks. The incorrect user total and incomplete DPA joins show why a prose summary cannot substitute for such a ledger. The current checks strengthen citation/completion discipline; they do not validate every legal conclusion, factual calculation or full-scale workflow. A fresh rerun must establish that the revised classification and agent instructions are followed.

## Validation and running-app state

- App suite: **734 passed**, zero failed. App typecheck and i18n audit passed; 5,031 keys in both shipped languages.
- Server suite: **1,273 passed**, 15 skipped, zero failed; after final bundle/test additions, 33 focused workspace/review/capabilities tests passed. Server build passed.
- Evidence helper: seven regression tests passed. Native export and empty-review guards were exercised on saved data without inference.
- Gateway’s real-container size tests passed; all four model-api PR checks passed.
- Updated review/capability plugins were loaded into the idle existing project engine; `legalwork_jev_evidence_export` is available among 124 tools. Electron and OpenCode PIDs remain 40847 and 40889. Non-plugin runtime fields and the existing profile were preserved.
- No full workflow rerun or visual review was performed. The 26-page measurement comes from the original session’s editor result, not a new screenshot or inferred word-count estimate.
