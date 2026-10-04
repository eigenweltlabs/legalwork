# SaaS DD report drafting: latest trial and fix

The latest **SaaS DD on data room** trial reached six completed reviews, but report generation repeated data preparation in model-generated Python programs. The Word conversion itself was fast. The workflow now supplies a native drafting handoff and a deterministic Word builder so the agent can spend this stage writing legal prose.

## Observed run

Read-only audit of session `ses_f0c6c1a1dffeQOT0D0vG4FONHu` found 82 tool calls. The user's count of 57 covers the final multi-review wait through delivery. After the six individual exports, the remaining 50 calls included 41 shell calls, 17 scratch Python programs and five syntax failures. That phase took approximately 589 seconds; template population took 0.19 seconds.

The six reviews cover 40 distinct legal records, 320 cells and 34 uncertain cells across 23 documents. The agent inspected all 34 uncertainties before writing the report. That made report drafting another source-review stage, even though an explicitly qualified draft could retain those outstanding questions. This audit does not establish legal correctness of the original prose.

## Resulting workflow

1. `legalwork_review_report_prepare` takes six review IDs and saved original-evidence indexes. It exports the exact grids and pinned manifests internally, retains all open decisions, computes full-scope distributions and assigns source references. One bounded reading file per class contains questions, counts, representative source names and original page-labelled excerpts. Excerpts and omitted sources are explicitly identified.
2. The agent reads those files and writes narrative fields and supported material findings directly with `write`/`edit`. The supplied field map replaces template inspection. Targeted source reading addresses specific material gaps; open decisions can remain open in a draft.
3. The supplied report builder expands source references, builds the executive/risk/action tables, checks exact quotations and current hashes, and populates the existing Word template once. It saves the report and full supporting registers under project reports. The agent opens the report, checks saved status and actual page count, and gives a brief executive-summary synopsis.

No legal inference runs in preparation or conversion. Native measured counts override draft edits. Failed source checks prevent a new report from being generated. The helper always labels this deliverable Draft; literal support does not establish legal validity or acquisition readiness.

During this DD drafting phase only, a tool hook redirects attempts to create new Python assembly/extraction programs to the supplied pipeline. Direct writing, targeted source reads, ordinary arithmetic and running the supplied helper remain available. Other workflows are unaffected; completing the plan clears the phase guard. There is no tool-call maximum.

## Larger rooms

The preparation call keeps every row on disk and gives the model distributions and representative evidence. JSON parts are bounded by encoded request size, including the file API's extra JSON escaping, rather than an arbitrary file-count batch. The packet manifest is written last. The helper loads the parts internally.

Findings may select a native answer group by review, column and answer values. The helper expands its source references internally, excluding uncertain answers, and verifies each cited quotation. Shared quotations must actually match every cited source. Different clauses still need targeted support. The Word report presents up to 30 material themes and representative citation names; full memberships and citations remain in its supporting register. This avoids asking the model to type 800 file IDs or putting a complete source list into the report.

These changes improve the **report handoff**, not full review execution. The pre-existing 64 MiB saved-review read limit and full-snapshot cell writes remain scale risks. A full 5,000-agreement inference run has not been validated.

## Validation

- `pnpm --filter legalwork-server test`: **1,283 passed, 15 skipped, 0 failed**.
- Focused native/report tests: **31 passed**, including a 5,000-agreement, eight-column packet retaining all 40,000 cells below the file request limit.
- Python report-builder checks: **10 passed**; source-evidence checks: **7 passed**. Cases include changed sources, unsupported quotations, uncited aggregate members, 800-source group expansion, unchanged open decisions, partition loading, output boundaries and mismatched packet identities.
- Server typecheck/build and `git diff --check`: passed. The helper is included in bundled core skills and CI.
- Technical replay on the saved six reviews: one preparation call (**0.124 seconds**), then one builder invocation using existing prose (**0.181 seconds**). It produced 18 findings with **29 verified citations**, no unfilled tokens, and retained **34 uncertain cells / 23 open documents**. These measurements exclude model drafting and do not predict the next agent's exact call count.
- Loaded the rebuilt plugin and updated SaaS skill into the existing idle dev app. Electron and OpenCode retained their PIDs; non-plugin settings and all session/message counts were unchanged. The engine exposes the new report-preparation tool.

No fresh model run, visual review, screenshots, or report pagination check was performed for this technical replay. The original report was preserved. The next trial should start a new chat, select the installed SaaS DD skill and request **Run SaaS DD on this data room**.
