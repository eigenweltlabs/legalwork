# SaaS DD rerun and scale audit — 30 September 2026

## Verdict

The audited session is **SaaS DD Data Room Review**, session `ses_f0da6c900ffeEPCg1g8aKP2dkG`, initiated with “Run SaaS DD on this data room.” This is the second run, separate from [the first-run audit](saas-dd-run-audit.md).

The workflow retained all 40 legal records, started six eight-column Jev-only reviews immediately, preserved all 320 saved answers in its CSV grids, and saved a 20-page Word report in the project. Those parts worked. **The report is not ready to present as final legal diligence:** it overstates completion, lacks dispositions for 39 of 40 uncertain cells, misroutes two shareholder agreements, fabricates five excluded-document titles, understates one revenue-exposure aggregate, and contains unsupported legal conclusions.

This audit used the existing running dev Electron app, its saved session, source PDFs, native review results and text of the saved report. The original report and registers were preserved. No screenshots, visual review, new review inference or complete workflow rerun were performed. The operator answer key was used only after the run to check the synthetic benchmark; it must never be made available to the workflow agent.

## What the run actually did

| Measure | Observed |
| --- | --- |
| Room coverage | 200 files; all source hashes match the operator corpus |
| Retained scope | 40 legal records; 160 operational records excluded |
| New corpus inference jobs | 2: screening and classification |
| Calls to the corpus tool | 21, including polling, pagination and original-source evidence reads |
| Native reviews | 6; 8 pure-Jev columns each |
| Cells | 320: 280 complete, 40 needs review, 0 errors |
| Python files | 19 written, 16 executed |
| Total tool calls | 85 in 71 persisted messages |
| Saved plan | No `todowrite` calls; empty todo list |
| Word report | 20 actual pages in the running editor; no unfilled placeholders |
| Final chat answer | 11,751 characters, repeating report detail |

The 21 corpus calls do not mean the model repeatedly screened the entire room. Only two jobs performed new inference. The remaining calls retrieved saved progress/results or original evidence. The product should keep those purposes distinct in its labels.

Review counts were customers 10, DPAs 8, MSAs 6, employment 6, corporate agreements 3 and shareholder resolutions 7. Correct routing is **corporate agreements 5 and resolutions 5**: records 030 and 107 are bilateral shareholder agreements, not unilateral decision records. The screening did not omit the founder-IP agreement, record 185, as the first run had done.

All six reviews were launched and started before waiting. The first four took approximately 48–53 seconds, corporate 5.8 seconds and resolutions 12.7 seconds, with overlapping work. The previous create-all-then-start delay is resolved in this run.

## Quality findings

| Priority | Finding | Required correction |
| --- | --- | --- |
| High | The report calls itself final and says every exception was verified by direct human inspection. Neither claim is supported. | Deliver a draft with explicit unresolved items; distinguish agent source inspection from actual human review. |
| High | The unresolved register contains seven alleged cell resolutions; only record 040 / `ip` matches an actual uncertain cell. The other six cells were already complete. | Reconcile by review ID, document ID and column key. Keep 39 unmatched uncertain cells open; even the matching entry lacks a structured source hash/page disposition. |
| High | Records 030 and 107 received the resolutions library. | Route bilateral shareholder agreements to corporate agreements, rerun that affected scope and reconcile report/actions. |
| High | Five excluded screening uncertainties are labelled with invented titles and AST-MKT references. | Use the actual source names and IDs. All five are Marketing drafts: records 020, 031, 054, 074 and 144. Their exclusion is substantively correct; their recorded identities are not. |
| High | The EUR 603,600 customer ARR exposure omits record 165 from an aggregate described as covering change-of-control/convenience risk. | EUR 603,600 is the correct subtotal for records 088, 125 and 089. Including record 165's EUR 183,600 gives **EUR 787,200**. Label the aggregation and avoid counting the same contract twice. |
| High | Some legal conclusions go beyond the supplied facts or applicable rule. | Separate source facts, qualified legal assessment and proposed deal protection. See examples below. |
| Medium | Four issue-bearing sources, records 030, 107, 115 and 158, have no entry in the findings register. Some appear in narrative. | Reconcile the entire affected-source set against findings and action owners; narrative mention alone is not structured coverage. |
| Medium | The report invents the adviser “LegalWork Advisory.” | Use only an instructed adviser/client identity; otherwise omit the attribution. |
| Medium | Mixed-source or abbreviated quotations are labelled as single verbatim quotations. | Store one exact quotation with one source/page per evidence entry; keep paraphrases outside quotation fields. |
| Medium | Process, statistical and JSON/provenance detail distract from buyer-facing legal writing; findings recur across several sections and chat. | Keep the legal report concise; put operational audit detail in companion files and give a short completion answer in chat. |

The benchmark contains 34 planted issue instances across 21 issue families in 26 affected sources. This run does not support a claim of complete material-issue recall or fully resolved legal diligence.

### Source and legal assessment checks

- Founder IP (185, clause 7, page 2), supplier IP (076, clause 7, page 2), customer IP (040, clause 7, page 2) and the employee's retained library (173, clause 3, page 1) are real issues identified in the report. The EUR 43,000 acquisition bonus total is correct in this run. The MSA minimum-fee total is EUR 485,800, consistent with the report's “exceed EUR 485,000.” The first run's amount errors must not be attributed to this rerun.
- Record 047 provides IP security but does not establish registration, perfection or the precise instrument form. Calling it a registered/floating security interest invents facts.
- A 75% holder/voting threshold must retain its contractual constituency. It is not automatically 75% investor consent or a share-capital threshold.
- The recommendation for a mandatory unanimous, notarised omnibus approval resolution and closing condition is unsupported. Section 15 GmbHG addresses notarisation of share-transfer agreements and obligations; it does not establish that every approval resolution requires that form. Check the actual articles and agreements before advising on approvals. [GmbHG section 15](https://www.gesetze-im-internet.de/gmbhg/__15.html).
- The absence of an express employee assignment does not alone establish absence of employer software rights. Section 69b UrhG provides employer economic rights for software created within the employee's duties/instructions, subject to agreement. Record 173's expressly retained independently developed library remains a concrete issue requiring analysis. [UrhG section 69b](https://www.gesetze-im-internet.de/urhg/__69b.html).
- Missing supplied TOMs or transfer paperwork is an evidence gap, not automatic proof that actual security or the transfer is unlawful. Verify processing roles, safeguards, any applicable adequacy route and the missing documentation. A seven-day processor notice clause requires assessment against prompt notification; the controller's 72-hour supervisory notification period starts with its awareness. [GDPR, Articles 28, 32, 33 and 44–46](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1680253036157&uri=CELEX%3A32016R0679), [EDPB breach-notification guidelines](https://www.edpb.europa.eu/system/files/2023-04/edpb_guidelines_202209_personal_data_breach_notification_v2.0_en.pdf).
- Categorical employment non-compete conclusions need a scoped legal assessment. Negotiation terms such as twelve-month fee caps, EUR 10 million insurance and three-year tax indemnities must be explained as proposed protections with a basis, not declared legal requirements or a proven market standard.

The exact-quote check matched the full normalised quotation for F-01–06, F-08–09, F-11 and F-15. F-07 concatenates passages and contains a non-verbatim third fragment. F-10, F-12, F-13 and F-14 contain matching individual passages but combine them in one field; split their source/page attribution. Record 183's clause 5 is on page 1. It is not one of the five proven unsigned records; its execution remains uncertain. The five source-confirmed unsigned copies are 065, 057, 025, 139 and 047.

The original six CSVs match every native cell value and status. The coverage ledger, however, contains aggregate counts rather than one entry per source, and the original manifest lacks a complete pinned column/source execution snapshot. New native exports described below remedy those export gaps without changing the saved decisions or clearing uncertainty.

## Why it stopped and why it wrote scripts

The first interruption is confirmed in the gateway logs: at 12:51:13 UTC the run was rejected with **USD 16.25118377365007 spent against a USD 16.16 cap**, followed by retries. That is a real budget block.

The later pause followed automatic compaction and a summary ending with `finish=stop`, after which the user supplied “continue.” No configured `maxSteps`, step or token limit was found for the active agent; no tool-limit error appeared. This establishes a compaction-associated continuation gap, not a proven hard limit on tool calls. The exact underlying compaction stop cause remains unproven. Existing reasoning-only-stop recovery excludes compaction, budget errors and ordinary answers, and requires unfinished todos; this run recorded none. Stage-plan and durable-checkpoint instructions were strengthened, but automatic recovery after compaction has **not** been changed or demonstrated fixed by this audit.

The compaction summary swaps the identities of records 185 and 047. This is direct evidence that a prose summary cannot be the source of truth for source identity, findings or completion.

The 19 scripts comprise seven source-analysis scripts, seven template probes and five deliverable builders. Sixteen were executed. Generated script text totalled 132,766 characters. The Word builder alone was 53,225 characters, and the largest individual tool return was approximately 43,639 characters. Building source/register/CSV content into code consumes output tokens and creates an avoidable second transcription of the data.

Needed native capabilities were:

1. Saved-result selections transferred directly between tools, without the model spelling out every path.
2. Exact saved-review grid, exception and provenance export.
3. Full per-file corpus coverage export.
4. Structured inspection/population of a DOCX template, including repeated rows and fields. The currently exposed editing tools do not provide this bulk file-template operation. One reusable file-based helper is appropriate until a native tool exists; repeated probes and hard-coded source data are not.
5. Bounded bulk source-evidence reading, persistent per-cell disposition and deterministic source/page/quote/hash validation.
6. A persistent findings/checkpoint record and a completion gate that reconciles coverage, uncertainty, findings, actions and report claims after compaction.

Items 1–3 are implemented in this PR and loaded in the running app. Items 4–6 remain product work; skill instructions improve discipline but are not an enforced completion gate.

## Changes made after this audit

- **Saved selections:** corpus classification and `legalwork_review_launch` accept `sourceSelection: {jobId, answers}`. The tool reads every matching saved page internally, verifies the completed stable selection and accepts only complete rows with the requested actual answer. A few individually resolved uncertain sources can be added explicitly. Uncertain/errors are never silently promoted into accepted classes.
- **Native review export:** `legalwork_review_export` writes the exact grid, all non-complete cells and a manifest of pinned columns/settings/source hashes. It returns compact counts and project-relative output references. It performs no inference and does not mark an exception resolved.
- **Native corpus export:** `legalwork_jev_corpus_export` writes per-file path, hash, answer, status, confidence and error plus coverage counts. Interrupted jobs retain unprocessed counts. Running, changing or incomplete pagination is rejected.
- **Compact library discovery:** `legalwork_review_library` supports `detail: "summary"`, providing installed identity/version, column labels/keys/kinds and compatibility. Launch still copies the exact underlying prompt definitions internally.
- **Less review overhead:** rebuilding the cell matrix uses a map rather than repeated linear searches, and document workers no longer reread the full review snapshot at every cell start. These backend source changes require the next native-server rollout; they are not claimed live in the preserved running service.
- **Installed/distributed skill:** clearer agreement-versus-resolution classification, immediate launch, stage plan, saved selections, native exports, source-backed per-cell dispositions, draft status, exact quotations, verified aggregates, durable findings and a 50-page maximum. Normal completion chat is limited to four short sentences with the deliverable and material open items, avoiding full paths and repeated report detail. The global deliverable guidance also discourages repeating the report in chat.
- **Production usage:** a persistent membership allowance policy is used by usage reads, new key provisioning and reconciliation. The signed-in member has USD 125/week; this survived manual reconciliation and the normal main deployment/reconciliation. Colleagues' allowances, subscription pricing and reset cadence were preserved. [Model API PR #63](https://github.com/eigenweltlabs/model-api/pull/63).

Against the saved run, the new tools produced 22 audit files under `reports/audit-rerun-2026-09-30/native`: six grid/exception/manifest sets and two corpus coverage/manifest sets. They preserve all 320 cells and expose all 40 uncertainties. The original deliverables remain unchanged. No corrected “final” report is asserted by exporting them.

## What happens at 5,000 files or 5,000 agreements

These are different workloads. The originally requested room has 5,000 files, including 4,200 obvious non-contracts: approximately **800 legal records / 6,400 review cells**. A room with 5,000 agreements requires **40,000 cells** with eight columns, before source verification and report drafting.

| Stage | Failure or friction in the observed approach | Fix or remaining work |
| --- | --- | --- |
| Screening | Enumerating thousands of files in model output wastes context. | Pass the folder directly. Jev uses bounded worker queues; pagination is not a corpus-size limit. |
| Screening → classification → reviews | The agent may have to write 800/5,000 IDs in a tool argument, with truncation and omission risk. | Use saved selection handles. A test transferred 6,001 matching records with an argument under 400 characters and a compact response. |
| Library discovery | Full prompt definitions occupied about 40 KB in the small run. | Summary discovery; exact definitions copied server-side at launch. |
| Native execution | Jev can accept the sources, but review persistence rewrites/validates the full snapshot on each update. | Map/redundant-read optimisations help; incremental durable cell storage and checkpointing are still required for reliable large-class operation. |
| Review storage | `readJson` rejects a saved JSON file above **64 MiB**. | Current real snapshots average about 16.0–17.4 KB per eight-column document. One class of 5,000 agreements projects to roughly **80–87 MB**, beyond this cap. Do not solve this merely by increasing the cap. |
| Result evidence | Bounded 24 KB pages, a 64 MiB query-snapshot budget and a 15-minute cursor lifetime cannot support indiscriminate full-evidence dumping. | Use compact overviews and targeted evidence. Use native exports for complete saved data; restart expired queries rather than combining inconsistent partial snapshots. |
| Export generation | The model generates source/CSV/register rows inside huge Python scripts. | Native grid/coverage exports preserve exact rows without generating them. Structured findings/dispositions remain needed. |
| Source review | Dumping all source texts into one shell response overloads context. | Read bounded passages for the affected source/question. Bulk evidence selection and dispositions remain a gap. |
| Drafting | Per-file narrative would exceed 50 pages and repeat findings. | Summarise per class and cross-cutting issue; keep full affected-file/evidence registers outside the Word report. |
| Continuation | Compaction can lose identities and completion state; budget/continuation issues already occurred at 200 files. | Persist structured checkpoints and verify them after compaction. The allowance fix removes the old small cap, not an assurance that any 5,000-agreement run costs under USD 125. |

The storage estimate is a projection from these six saved reviews, not a full-scale execution benchmark. At observed sizes, the 64 MiB boundary would be reached at roughly 3,850–4,200 documents in a single class. Balanced classes may stay below that individual file cap while still suffering full-snapshot I/O/CPU cost. Corpus progress also uses whole-job JSON checkpoints, coalesced at 500 ms; it should be included in load testing. Native text writes currently cap an artifact at 5 MB; longer free-text exports will eventually need streaming/chunked files.

An isolated exporter test preserves 5,000 agreements and 40,000 cells, including quoting, final document, source provenance and uncertain statuses. It does **not** prove execution, persistence, a full report or legal quality at that scale. No 5,000-agreement end-to-end run was performed.

### The smoother agent flow

```text
room folder
  → saved screening job + complete coverage export
  → saved classification job using screening selection
  → six immediate library launches using classification selections
  → wait for all six, then exact native exports
  → bounded exception/source checks + persistent findings/dispositions
  → class summaries + cross-class reconciliation
  → one concise legal report + completion validation
```

For example, the next call can use `sourceSelection: {jobId: "<classification job>", answers: ["Customer Agreement"]}` with the installed library ID/version. The number of matching agreements does not change the model's argument length. A saved selection remains a reference to accepted classifications, not a representation of legally resolved uncertainty.

Summarisation is needed **after each class's substantive source checks**, before cross-class synthesis, and before drafting. Each class summary should contain verified scope/status counts, ordinary term patterns, material exceptions, exact affected-source references, supported amounts, open evidence requests and proposed actions. A second pass merges overlapping IP/consent/execution/privacy themes and reconciles aggregates. The final Word report presents material deal issues once; the full source and unresolved registers retain individual coverage outside the 50-page limit. The final chat should only link the report and identify material open issues.

## Readiness and next acceptance checks

Ready now: folder-only screening, immediate installed Jev-only launches, saved-selection transfer, compact library discovery, exact native review/corpus exports and brief-completion guidance. The two export tools were exercised against the original running dev app without replacing its profile or restarting Electron/OpenCode.

Final server validation: **1,271 tests passed, 15 skipped, 0 failed** across 164 files; server typecheck and bundle build passed. The active project engine exposes both export tools and is idle. Electron and OpenCode retain their original process IDs. The production main deployment completed successfully; subsequent checks retained the USD 125 weekly grant and the running app reported USD 116.58 remaining.

Before claiming the 5,000-agreement workflow is ready:

1. Replace per-cell whole-snapshot persistence with incremental durable storage, preserving revisions, restart/cancellation and pinned provenance; benchmark both one large class and six uneven classes.
2. Add native bulk evidence/disposition and completion validation; require all 40 uncertain cells in this corpus to be resolved with evidence or explicitly reported as open, with zero fabricated identities.
3. Add structured DOCX template inspection/population and a durable findings/checkpoint capability; test automatic continuation after compaction without continuing budget errors or overriding new user input.
4. Rerun the 200-file workflow after explaining these fixes, verify correct 5/5 corporate/resolution routing, source-backed figures/quotes and actual page count, then scale. Do not call a 20-page report final simply because it fits the limit.

Raw checks are retained in the local audit bundle: `cell-and-coverage-check.json`, `finding-citation-check.json`, `scaling-sizes.json`, `stop-events.json`, saved messages, source hashes, report text and native snapshots. Source/config secrets are not part of this PR.
