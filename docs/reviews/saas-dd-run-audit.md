# Audit of “SaaS DD data room review”

30 September 2026 · Existing LegalWork Dev project: SaaS DD Some Company

The run completed six native, pure-Jev reviews and saved a Word report, but the report is not a reliable completed DD result. It silently omitted a material founder agreement, overstated clearance of uncertain cells, introduced factual and quotation errors, and delivered metadata-only grid exports. The current run should remain a draft pending correction. The original report and six original reviews have been preserved.

This audit inspected the saved session, every tool call, both saved Jev jobs, all six native reviews, the report’s Word content and registers, and the original source PDFs. The presenter’s answer key was used only for this retrospective audit. All 200 input hashes match the answer key and saved screening job. No answer-key read appears in the original agent’s tool calls. Checks in the running Electron app used native APIs and DOM geometry; no visual review or screenshots were performed.

## Coverage and execution

| Measure | Expected or observed |
| --- | --- |
| Input records | 200: 40 legal records, 160 operational records |
| First Jev gate | 152 accepted operational, 34 bilateral agreements, 5 corporate resolutions, 9 uncertain |
| Retained by agent | 39 legal records; record-185.pdf was incorrectly excluded |
| Original reviews | Customers 10; DPA 8; MSA 6; employment 6; corporate 4; resolutions 5 |
| Actual native cells | 312 processed: 270 complete, 42 needs review, 0 errors |
| Review inference | All original cells used Jev; no LLM fallback |
| Report findings | 20, with 5 critical / 10 high / 5 medium assigned by the drafting agent |
| Register quotation checks | 7 of 20 quote fields are not verbatim source quotations |
| Delivered grid CSVs | Six files containing one metadata row each; no document/answer rows |

The initial screening was cautious enough to retain uncertainty. The downstream agent defeated that safeguard: it inspected only four of the nine uncertain records (018, 045, 071, 074), then called all nine marketing drafts. It never read record-185.pdf. That file is the fifth corporate agreement: AST-G-045, a founder IP instrument. Page 2, clause 7 states:

> Founder retains ownership of the Atlas orchestration module in Schedule A. AsterCloud may use it only until the founder ceases to hold any shares.

This is a material dependency in the contemplated acquisition of 100% of shares. The report omits the retained-IP/licence issue and also misses this file from its affected-document list for shareholder transfer restrictions. The supplied corpus contains 21 planted issue families in 34 instances; the run missed these two instances and did not identify the five expressly unsigned documents individually.

The second Jev job classified only the 39 retained files. It returned 11 uncertain results and some accepted wrong classes: records 030 and 107 were called resolutions, while 101 was called an MSA. No customer file received an accepted Customer Agreements answer. The agent’s source inspection corrected the routing of the 39 retained files, including ten customers, but did not leave a measured routing-resolution ledger. That correction does not cure the first gate’s omitted source.

The original execution column produced 32 accepted “Missing signature” answers. Only five correspond to expressly unsigned records: 025 (MSA), 047 (corporate), 057 (DPA), 065 (customer), 139 (employment). The other 27 are false positives against the supplied execution wording. Seven remaining execution cells needed review. Across the complete 40-record source set, 35 records have apparent execution wording and five expressly lack execution. Apparent execution is a source observation, not signature authentication or a legal validity opinion.

The report nevertheless asserts all cells were verified and no issues remain open. The saved reviews contain 42 needs-review cells, and there is no document/column-specific resolution evidence for clearing all 42. Completion of inference is not clearance of those cells.

## Report findings checked against the source

The report identifies many of the intended substantive risk themes, but its source facts, legal conclusions and proposed transaction protections need to be distinguished. The findings below assess factual support, not legal enforceability or regulatory advice.

| Finding | Audit result and necessary correction |
| --- | --- |
| F-001 · Customer platform IP | Record 040, p2 cl7 supports the ownership flag. The description as an existential threat and mandatory closing assignment are assessments/proposals, not source facts. |
| F-002 · Vendor engine IP | Record 076, p2 cl7 supports retained engine IP and licence restrictions. Its p1 cl3 requires prior consent; the report adds a termination right that is not stated. The quote combines text with editorial additions. A share acquisition is not automatically an assignment. |
| F-003 · Secured shareholder debt | Record 047, p2 cl6 supports €410,000, 6% interest, acceleration on control and IP security. Funds-flow treatment is a proposed response, subject to assessment. |
| F-004 · Quorum shortfall | Record 038, p1 cl2 states 60% participation against a stated 75% requirement. The report’s invalidity conclusion and demand for a notarised, unanimous 100% resolution go beyond that evidence. |
| F-005 · Conditional corporate approval | Record 183, p1 cl5 supports outstanding accompanying consent/release evidence. “Legally suspended” is an unsupported conclusion; describe the supplied-record gap and conditions. |
| F-006 · Employee IP/control payment | Record 173, p1 cl3 retains the Atlas authentication library; cl5 states an acquisition payment of **€43,000**, plus option acceleration above 50% control. The executive summary says **€173**. The quote is a paraphrase and points to outside-project language not in cl6. Compaction also introduced the wrong filename, 197. |
| F-007 · Customer control consent | Record 165, p1 cl3 supports consent and termination on failure to obtain it. The report overstates this as automatic immediate termination on acquisition. ARR €183,600 is supported; the quote includes editorial additions. |
| F-008 · Control termination ARR | Records 088 and 125 support €156,000 + €195,600 = €351,600 and 30-day indirect-control termination wording. Outreach is a proposal. |
| F-009 · Uncapped customer liability | Record 125, p2 cl6 supports the flag. A cap or SPA indemnity is a proposed mitigation, not an existing contractual requirement. |
| F-010 · Uncapped MSA liability | Record 006, p2 cl6 supports the flag. The claimed supplier’s own cap under cl7 is not expressly stated there; cl7 addresses the IP indemnity and general cap. Narrow the finding. |
| F-011 · Exit/data withholding | Record 090, p2 cl9 supports withholding/export and assistance risks. The quote contains editorial additions. The €66,400 minimum annual fee is on **p1 cl2**, not supplied by cl8. |
| F-012 · MSA control termination | Record 115, p1 cl3 supports the 30-day indirect-control right. “Critical infrastructure” requires business context beyond the contract. |
| F-013 · DPA safeguards gap | Record 138, p1 cl5 and p2 cl6 support non-EEA access/safeguard and missing-annex concerns. The quote is a paraphrase. Regulatory breach/fines are legal assessments, not established source facts. |
| F-014 · Holder consent/ROFR | Records 030, 047, 107 and 158 support 75% consent and a 20-day ROFR. **Record 185 must also be included.** A 100% SPA waiver is a proposal; the source threshold is 75%. |
| F-015 · Reserved corporate rights | Record 085, p1 cl4 supports the reserved-rights flag. Superseding the historical resolution needs assessment; it is not an express source obligation. |
| F-016 · Convenience termination ARR | Records 089 and 165 support €252,000 + €183,600 = €435,600. Record 165 also occurs in the control-risk group; do not add overlapping ARR groups. “Nine standard customer agreements” is inconsistent with three contractual exceptions. |
| F-017 · Subprocessors | Record 132, p1 cl4 permits replacements without notice or an objection right. The quote is not verbatim. A blanket noncompliance conclusion requires legal assessment. |
| F-018 · Breach notice | Record 001, p2 cl7 states seven-day notice. Distinguish contractual timing from statutory duties and the parties’ roles. A proposed 48-hour term is a mitigation, not current wording. |
| F-019 · Employee restraint | Record 103, p2 cl7 supports a worldwide 24-month restraint without compensation. The report’s definitive unenforceability conclusion is not established by the source alone. |
| F-020 · Execution | Replace the blanket allegation about all 39 records with the five expressly unsigned source records listed above and any specifically unresolved execution evidence. Its quote field is not a quotation and provides no usable document-specific support. |

The seven non-verbatim register quote fields are F-002, F-006, F-007, F-011, F-013, F-017 and F-020. F-002/007/011 mix genuine passages with bracketed editorial text; F-006/013/017/020 use paraphrase or generalisation. Quotations, paraphrases and assessment must occupy distinct fields. A correct risk theme does not excuse a fictitious quote, wrong amount, wrong clause or unsupported legal conclusion.

## Tool calls, timing and stops

There were 94 tool calls, including 40 Jev calls. Only **two** created inference jobs; the other 38 polled or read saved pages/source evidence. The repeated labels made these reads look like repeated searches. All saved result pages were fetched for the six reviews; pagination did not cause the lost founder agreement.

The agent spent about 2 minutes 25 seconds inspecting 28 retained originals before launching reviews. It then created all six reviews serially, from 12:25:00 to 12:26:35 (Europe/Berlin), and started them together at 12:26:35. The first creation was complete at 12:25:21: its inference could have started about **74 seconds earlier**. Immediate create-and-start per class removes that unnecessary dependency. Once started, the six reviews settled before 12:27:53. Multi-review waiting worked; the delay was launch orchestration, not an inability to run multiple reviews.

The second unexplained stop at 12:31:29 is distinguishable from the earlier reported budget stop. Its saved assistant message has `finish=stop`, 63 reasoning tokens, **zero output tokens**, no text, no tool call and no error. The user’s next “continue” is at 12:34:12. This supports a reasoning-only normal provider/model finish; it does not show a maximum-tool-call error. The active runtime configuration has no agent step limit. OpenCode v1.18.29 defaults `agent.steps` to infinity and exits its loop on a normal finish without further tool calls: [pinned engine source](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.29/packages/opencode/src/session/prompt.ts). Provider-side causes cannot be established from this transcript alone.

A later context overflow at 12:36 triggered compaction after a very large report-generation write. The resumed summary carried wrong facts, including record 197 and “all nine marketing drafts.” Drafting from a persisted manifest, source-linked finding register and measured coverage ledger reduces reliance on a compressed recollection. The original to-do list still has the report stage in progress after the final delivery claim.

## Saved report, exports and editor

The report **was saved to the project before it was opened**: the generation script ran at 12:36:15, a file listing verified the DOCX in `reports/` at 12:36:18, and the open tool ran at 12:36:37. The later manual Save replaced the file, explaining its newer filesystem birth timestamp. This evidence does not support a failure to persist the original deliverable. A fresh reopen in the running app reports no unsaved changes.

The six delivered grid CSVs contain metadata rather than actual results. A later `update_grids.py` script was written but never executed; it defines legacy 32-column labels inconsistent with the installed eight-column sets. This audit exported the actual original rows and eight native decisions, with companion statuses, into six `native-grid-*.csv` files. These exports preserve uncertainty and do not pretend to clear it.

The Word file has 24 editor pages. There is no 11-page document cap. The running app exposed a zoom/scroll mismatch: the unscaled layout occupied roughly 27,600 px while the painted pages occupied about 9,455 px. The unused scroll region made later content appear absent. Matching the scroll track to the scaled layout corrected that mismatch; native DOM checks confirmed page 24 populated its body/header/footer. This was a structural check without screenshots or visual QA.

## Changes made and validation boundary

The existing PR now includes compact grouping of review widgets from the same user turn; distinct Jev inference/result/source labels; `legalwork_review_launch`, which copies a pinned installed set and immediately starts a whole-class review without a document-count cap; and the Word scroll-height correction. Failed and pending actions remain individually visible. A bounded recovery hook handles the observed reasoning-only normal stop once during unfinished review work. It fetches the originating user message directly when many tool steps separate it from the stop, tracks successful review events for long workflows, and can inspect a bounded saved history page after an engine reload. A regression test covers the observed absence of both the request and review tools from the latest ten messages. It does not continue errors, budget stops, completed responses, compaction or a session with new human input.

The installed SaaS DD skill now requires source inspection of every uncertain screening record, evidence for resolving individual uncertain cells, immediate review starts, persisted coverage/manifest data, actual native-row exports, and amount/quote/clause checks before completion. All six installed libraries remain eight-column, pure-Jev sets; their execution prompt now distinguishes apparent execution from explicitly missing signatures. Original reviews remain pinned to version 1; the updated installed sets are version 2.

Two focused reviews ran through the existing Electron app’s native service, with no app/profile replacement:

- Execution/customer source check: records 013 and 040 returned Apparent execution; explicitly unsigned 065 returned Missing signature. All 24 cells settled; unrelated uncertain results remain visible.
- Omitted founder check: record 185 produced eight completed Jev decisions, including the IP carve-out and transfer-consent flags.

Automated validation passed: 729 app tests, 144 focused server/corpus/review tests, app/server type checks, server build, and i18n completeness (5,030 keys in each of two languages). The original 200-file DD report was preserved. A separate corrected legal draft was subsequently created at the user’s request; a fresh complete 200-file workflow has **not** been rerun. These fixes and focused checks support the next test; they do not establish full-run recall or eliminate report-model mistakes.

The next complete acceptance run should retain all 40 legal records (corporate 5), preserve or explicitly resolve every uncertain cell, identify the five unsigned records individually, include founder record 185, use €43,000 for record 173’s control payment, produce real eight-column grid rows, and save the measured report/registers in the project without a manual “continue.” Keep the presenter’s answer key outside the agent’s authorised room.

## Later requested legal writing and response changes

The skill and template now require a buyer-facing legal report, without Jev, model probabilities, tools, review IDs or workflow mechanics. The 5,000-file report is limited to 50 pages including cover and every appendix, targeting 25–35; full document lists, grids and technical audit records remain separate. The editor’s read-draft action now returns the actual rendered page count so the agent can check the final revision rather than estimate it.

A separate **Project Aster Legal DD Report Revised Draft** was saved to the project and opened in the existing app. It has 21 findings, including the omitted founder instrument; corrected amounts, consent/termination distinctions and execution gaps; 43 source-matched supporting passages in the revised findings register; and no technology descriptions or absolute filesystem paths. The running editor measured **20 pages** at draft revision 0. The report remains a draft with outstanding supporting-evidence requests. It is a source-checked correction, not evidence of a new successful autonomous DD run.

Global app guidance and the DD skill now tell the agent to use document names and project-relative links in answers, keeping absolute paths and installed-resource locations within tool arguments. This is a response instruction, not destructive redaction of source evidence.

## Project file sidebar changes

Local files, folders and the current folder now have a Finder reveal context action through the existing Electron bridge. Remote project entries do not offer a local Finder action. On Windows the same action uses the existing Explorer label and bridge.

The visible project file pane refreshes its current directory every two seconds while the app is in the foreground, refreshes on returning to the window, and invalidates its project listing when an agent run finishes. Hidden/collapsed panes retain their folder and scroll state without polling. This covers files written by scripts or external applications that do not emit an engine file event.

A functional check in the existing app created and removed a temporary file under Reports without manual refresh; both changes appeared, the current folder stayed selected, and the Finder action was triggered from that file’s context menu. The temporary file and diagnostic actions were removed. No screenshots or visual review were performed.

## Further product improvements suggested by this run

The revised skill expresses the necessary checks, but instructions alone do not enforce them. The next useful product step is a native run manifest with source dispositions, routes, library versions, review IDs and a resumable stage checklist. Completion should fail visibly when a retained source is missing from reviews or a claimed resolution lacks evidence.

Add a source-supported resolution action for uncertain screening decisions and review cells, preserving the raw Jev answer/probability alongside the resolver and cited passage. This would make “verified” measurable instead of a report assertion. Keep inference completion and diligence clearance as separate statuses.

Expose project-saving grid export to the agent using the existing grid export logic, rather than asking it to recreate CSV rows from memory. Before final delivery, check source/row counts, column identities, quote matches and unresolved totals against native data. Material legal assessments should remain explicitly identified as assessments.

Evaluate the six-way routing question separately from the screening gate: this run had no accepted customer classifications and three accepted wrong classes. Refine the customer-subscription versus vendor-services and corporate-instrument versus resolution wording against a held-out corpus. Do not mask the issue by lowering probability thresholds.

## Audit evidence supplied

`audit-summary.json`, `coverage-ledger.csv`, `unresolved-original-cells.csv`, `execution-checks.csv`, `quotation-checks.csv`, and six `native-grid-*.csv` files accompany this document in the project’s audit report folder. The deeper local audit folder also preserves the original transcript exports, loaded skill, extracted source/report text, focused review snapshots, and the reconstruction script. No credentials or runtime configuration are included in the audit bundle.

## Persistent workflow plan

The live `todo.updated` event updated the plan cache, but session metadata changes replayed a previously fetched snapshot with empty/older todos and overwrote it. This explains the brief appearance followed by disappearance. Snapshot reads now record when they started; only a fresh read can replace existing todos, and a live update received while that read was in flight wins. Replaying a cached snapshot cannot reset an existing plan.

The composer keeps an unfinished plan visible independently of busy/idle status and alongside questions or approvals. Its collapse state survives progress and metadata updates. It disappears only when every nonblank step is completed or cancelled. The regression tests cover metadata/idle replay, in-flight reads, subsequent authoritative completion, and project/session boundaries. A functional check in the existing Electron process verified visibility, expand/collapse, stale-snapshot resistance, and disappearance on completion. The original session's todos were restored after the check; no workflow or inference was started.
