# Native project Tabular Review

Tabular Review is a saved project page backed by the server review service. Users select project documents, add typed questions or saved prompt sets, and run a persistent table. Agent-created reviews use the same service and appear in the same page, with live chat cards that open the review.

The chat card stays outside collapsed command activity. Create/start actions for the same review share one card, including when prose separates them. Clicking the card opens that exact project review. Its accessible progress bar remains visible after completion or stopping, with processed/total cells, active and queued work, document preparation and attention counts. Active cards refresh every second; inactive cards refresh less frequently so later runs are picked up without agent polling. Reopening a card always refreshes saved state, even when a draft was cached. If a fetch fails, the card keeps the last known progress and visibly reconnects.

The packaged `start-tabular-review` skill teaches the agent to read enforced settings, reuse library prompts, create and start the review, and finish with at most one short sentence. It is a core skill, hidden from Workflows. Exact attached paths need no discovery; `legalwork_review_files` provides paginated file discovery without a project inventory widget. Creation assigns a stable retry ID from the session and normalized request, including across transport retries; the agent supplies no UUID. Incidental project inventory calls in historical review-start turns stay in collapsed tool activity instead of producing a second card.

Agents read saved reviews through `legalwork_review_results`, using the review ID already in the conversation; discovery uses `legalwork_review_list` only when needed. The default overview computes counts, accepted answer distributions and typed ranges across the entire matching review. `view: "answers"` returns document-specific findings; `view: "evidence"` adds exact citations, explanations, provenance and every decision probability. Filters support documents, columns, statuses, evidence states, exact accepted values and case-insensitive text search across selected fields. Numeric/date comparisons and value sorting require one column; currency comparisons require an explicit ISO currency and never convert amounts. Absent, stale and uncertain answers cannot become zero or accepted numeric matches.

Agent queries use the read-only `POST /workspace/:id/reviews/:review/results/query` endpoint, available to viewers even when the server is read-only. Responses stay below 24 KB with explicit coverage and an opaque continuation cursor. Follow-ups need only the review ID and cursor; a bounded, project-scoped snapshot cache retains a consistent result version for 15 minutes. Expired/evicted snapshots require a fresh query, never combining pages across versions. Large quotes and answer text use ordered, lossless fragments; compact answer previews explicitly mark truncation. No model inference or source extraction runs when querying results. The older offset/revision GET endpoint remains available for compatibility, but is not exposed as the agent results tool.

The table's search and Filter & sort controls use the same result-query semantics through the read-only `POST /workspace/:id/reviews/:review/rows/query` endpoint. Matching document IDs retain the selected ordering; filters can combine a column, exact answer, result status, literal search and typed comparisons. Currency comparisons require a currency explicitly. Not found is a completed absence result, separate from uncertainty and failed cells.

Rows and columns render through a bounded virtual window with pinned document labels and headers. Arrow keys, Home/End and Ctrl/Cmd+Home/End reach offscreen cells. Review pages and chat cards use `GET /workspace/:id/reviews/:review/updates?revision=...`: unchanged revisions return a small acknowledgement, changed revisions return changed cells and metadata. A bounded fingerprint cache falls back to a full snapshot after restart, expiry or eviction. Reruns replace previous cell results immediately. Fully processed reviews offer Rerun all; Continue review is reserved for unfinished work, excluding columns disabled by Only JEV.

## Execution settings

Settings → Tabular Review configures the default mode, JEV provider/model, LLM provider/model and minimum answer probability for new reviews across all projects. These defaults are saved in application state; legacy project-level defaults no longer override them. Existing reviews retain their own settings, editable in the review's settings dialog. Agent-created reviews inherit the same global defaults. Agent tools can read these settings but cannot change them or pass an alternate backend into creation, editing or execution.

| Mode | Review inference |
| --- | --- |
| Only JEV | Yes/no predicates and fixed-choice classification only. Preserve probabilities. No LLM inference, free-text explanations, score questions or fabricated citations. |
| JEV + LLM | JEV for yes/no and classification; the selected LLM for text questions. |
| Only LLM | The selected LLM for every question, including context assessment. No JEV inference. |

The recommended defaults are JEV + LLM with managed EigenJev and an EWL model for Eigenwelt subscribers, regardless of their general chat model or another selected JEV provider. Without a subscription, a configured, enabled JEV provider selects mixed mode; otherwise the default is LLM mode. “Use recommended defaults” clears the user's saved override and restores these automatic choices. Explicit saved choices remain unchanged if a provider disappears. Missing models, provider errors and incompatible columns produce errors rather than a fallback. The editor and backend reject text columns and explicit extraction/explanation instructions mislabeled as JEV decisions. Fixed output schemas remain enforced at inference; lexical question checks do not prove arbitrary natural-language intent.

## Evidence and recovery

PDFs and images use the shared document-preparation service. Each run pins one OCR configuration for its selected documents. Native text, OCR text and region references remain distinct. DOCX extraction includes body, headers, footers, comments and notes; drawings and tracked changes are marked as uncertain.

The context splitter follows the demo's overlapping, paragraph/sentence-aware windows. Relevant passages are combined for the final answer within the selected model's context limit. Insufficient relevance, incomplete recognition or supporting passages that cannot fit together produce **Needs review**, rather than an absence claim. JEV answers expose probabilities without pretending that JEV returned quotations. LLM quotations are checked against the prepared evidence.

LLM quote matching tolerates layout whitespace (including line wraps and non-breaking spaces), then stores the exact source substring. Wording, punctuation, page/source identity and OCR regions remain verified. Not found / Needs review answers discard incidental citation metadata rather than failing the cell. A genuinely invalid citation gets one correction attempt through the same selected LLM and provider queue; if verification still fails, the result becomes Needs review without an unsupported finding or citation. Provider/authentication errors remain errors. Source previews use the same whitespace rule when validating highlighted OCR regions.

Results keep the executed prompt, model, source hash and evidence references. Source citations revalidate the file and open its original page in the existing right panel. The viewer highlights the cited PDF text spans in yellow and scrolls to them, including partial lines, wrapped sentences and rotated pages. Scanned pages use matching OCR word/line regions, inferred from the quote if the model omitted region IDs. This also works for saved results without rerunning inference or OCR. If a scan has no usable position data, the quote stays visible with a localized explanation; no highlight location is invented. Stale files require a rerun. Users can stop, resume or rerun selected cells. A restarted server marks unfinished runs as interrupted and retains completed answers. Billing/authentication failures stop promptly instead of leaving the grid in an endless provider retry.

OCR starts inside the review runner; separate OCR tools are not exposed to the agent. LLM requests have a three-minute deadline with at most three attempts through the shared queue. Each timeout aborts and removes its temporary inference session; exhausted retries leave a visible cell error that can be retried independently. Cancellation does not retry, and completed sibling cells remain untouched.

## Prompt library

The library contains English/German starters, individual saved columns and named sets. Personal names and prompts remain literal in either language. Users can inspect the complete questions/options, save and edit entries, and explicitly update copied columns. Each edit creates a new version; personal prompt snapshots stay unchanged until explicitly updated. The built-in fallback safety update automatically upgrades untouched version-2 decision columns in idle reviews. User-edited prompts remain unchanged; old executed prompts and answers are preserved in history and affected results are marked stale for rerun. Agent tools can discover, read, save and reuse the same definitions. Sharing across firms remains part of the existing sync/sharing work.

Add column uses the same Sets / All prompts tabs and form controls as Workflows. A compact list and scrollable preview expose questions and answer options before adding; additional instructions expand on demand. Selecting an individual prompt adds only that column, even when it comes from a set. Compatibility warnings appear only when the selected definition cannot run under the review's mode.

The defaults include 12 decision-only sets: NDA, commercial agreement, commercial lease, credit agreement, change of control, employment, shareholder agreement, share purchase agreement, supply agreement, limited partnership, e-discovery triage and due-diligence triage. All run in Only JEV, mixed or LLM mode. Exact names, dates, amounts, notice periods and detailed findings are separate optional LLM columns. All built-in decision prompts now include Not found, Not applicable and Unclear (and their German equivalents). Former binary checks use fixed-choice Yes/No plus these fallback options: silence cannot become No. Every JEV decision must meet the saved minimum answer probability (80% by default, adjustable from 50–100% in Review settings); an exact 50/50 tie always needs review. Answers below the threshold become Needs review while the raw distribution remains available. Cells show the probability of the displayed answer, and details/popovers show all outcomes, including both Yes and No. Older low-probability results are flagged on load; changing the threshold marks affected JEV results for rerun. This is a conservative abstention rule, not a calibrated accuracy guarantee. Incomplete OCR or unassessed source passages cannot establish absence.

Country columns enumerate 25 countries plus Other country, Multiple countries, Not found, Not applicable and Unclear within the 30-choice limit. Governing law and dispute forum are separate decisions; a further legal-system column can distinguish English/Scottish/Northern Irish law and selected US states. Country classifications are intentionally coarser than exact legal-system extraction. Multi-part checks such as NDA carveouts are independent columns, so one missing exception cannot be hidden in a single broad answer. Triage columns identify possible issues, not established legal conclusions.

Topic coverage was checked against [Mike's tabular workflow library](https://github.com/open-legal-products/mike-workflows/tree/main/tabular-review-workflows), which includes 11 general workflows and five Finnish/Polish jurisdiction-specific workflows. The general topics were adapted into bilingual decision prompts; the jurisdiction-specific packs are not shipped as purportedly validated local-law reviews. Attribution is retained in `THIRD_PARTY_NOTICES/mike-workflows.txt`. These defaults use the native review-library API and agent tools, not legacy executable review skills.

## Legacy migration

The bundled `tabular-review` artifact skill, HTML builder and `tabular_review_row` / `tabular_review_models` registrations are removed. The shared PDF reader retains its PDF.js assets under `pdf-tools`.

On startup, obsolete project skill/command folders are moved into `.opencode/legalwork/retired-reviews`, outside skill discovery. Shared-library copies move to `legalwork-retired-reviews` beside the skills directory. Customized files are preserved. Exact app-generated workflow wrappers migrate to saved-review tools while keeping the user's column definitions. Existing HTML result files remain readable.

## Verification and remaining acceptance

Focused automated checks cover execution policy, model selection, no fallback, prompt versions, source boundaries, citations/regions, context offsets, idempotent starts, cancellation, restart recovery, pinned OCR and legacy migration. English/German keys and app/server type checks are included. Desktop registration now preserves server-created projects across relaunch.

Saved-result query checks cover a 60-cell overview in one response, complete 2,000-cell answer retrieval, 6,000-cell aggregate pagination, typed filtering/sorting, currency isolation, absent/uncertain/stale semantics, project/review boundaries, tampered/expired cursors, immutable snapshots and lossless multilingual evidence. The native development backend returned the real 60-cell review overview in about 7 KB. Two isolated agent smoke turns each used one `legalwork_review_results` call: a complete overview, followed by a filtered automatic-renewal query that returned the correct document. Neither used file/shell recovery calls; the temporary chat was removed afterward.

The final table/picker check in Electron on 25 September reached document 100 / column 60 with scrolling and keyboard navigation, retained pinned labels, filtered the real automatic-renewal results to the single matching document, and added one individual library prompt to a disposable review. A synthetic 6,000-cell benchmark on the development laptop measured a 5,062,820-byte full snapshot versus a 190-byte single-cell patch; fingerprint generation took about 17 ms initially and 14 ms for the patch, with a typed filter taking about 7 ms. These are local synthetic measurements, not inference throughput or a hardware-wide benchmark. The existing 100-document / 60-column limits remain unchanged. The disposable review was removed after verification.

The agent-start regression check on 25 September used the running Electron backend with a one-question PDF review. The final run called create/start, returned one short sentence, and did not call OCR, generate a UUID, show a project widget or poll results. The runner produced prepared evidence and a completed answer. A separate targeted recovery completed the one pending cell in the five-document commercial review; hashes confirmed all 109 earlier completed cells were unchanged. Focused tests cover timeout retries/exhaustion, cancellation cleanup, automatic creation IDs, file discovery, bundled skill seeding and workflow exclusion, and suppression of historical setup inventory cards.

Electron checks on 25 September 2026 verified project/review creation, document selection, library import/save/edit, German screens/date formatting and local OCR installation. An explicitly labeled UI fixture verified opening the original source page and its selected region; this was not a model result. The higher-quality local model completed its built-in sample. This is a setup smoke check, not handwriting or diligence accuracy acceptance. The real LLM attempt correctly exposed the account's billing error in its cells and stopped retrying.

The local model API and real JEV route are connected. On 25 September, 24 real requests through the local gateway with 16 workers returned HTTP 200. Artificial key/team RPM, TPM and concurrency caps have been removed for the dedicated development credential; LegalWork controls local cell concurrency. This connectivity check does not establish extraction accuracy. See `systemone-dev.md` for the setup.

EIG-210 remains open for the labeled multilingual OCR/DD evaluation, split and handwritten clause recall/false-positive measurements, hardware/resource measurements and real JEV/mixed-mode acceptance. Search reuse is tracked in EIG-211 and final sprint-wide UX acceptance in EIG-214. Production EigenJev rollout remains EIG-209.

Focused commands:

```sh
pnpm --filter legalwork-server exec bun test src/reviews src/document-preparation/citations.test.ts src/opencode-plugins/legalwork-review-tools.test.ts src/workspace-init.test.ts src/opencode-plugins/legalwork-skill-tools.test.ts
pnpm --filter @legalwork/app exec bun test tests/workflow-editor.test.ts tests/tool-runs.test.tsx tests/review-card.test.tsx
node --test apps/desktop/electron/workspace-store.test.mjs
pnpm --filter @legalwork/app typecheck
pnpm --filter legalwork-server build
pnpm --filter @legalwork/app exec bun scripts/i18n-check.ts
```


### Reusable prompts in Workflows

Workflows uses **Local / Team** as its top-level scope, with **Workflows / Tabular Review Prompts** underneath. Local → Tabular Review Prompts contains **Sets** and **All prompts**. Team prompt/set synchronization is future work tracked in EIG-208; the Team view does not expose local entries as shared. Sets store ordered column definitions; All prompts includes standalone entries and questions used in sets. Identical set questions link back to their sets. Personal copies remain distinct from built-ins. A set can contain just one prompt; the persisted `kind` distinguishes it from a standalone prompt. Entries saved before this field existed remain readable using their column count.

Users can create, edit, copy built-ins, and remove personal library entries. Edits create a new version; existing reviews and other sets keep their stored snapshots. The bundled `author-review-prompts` skill directs agents to `legalwork_review_library_save`, including typed answers, JEV compatibility, and absence/uncertainty fallbacks. It is not a user workflow.

New tabular workflow creation is retired. Legacy `workflow-tabular-*` names and `workflow_type: tabular` files are classified as ordinary workflows on read. Their original names, paths, resources and contents are preserved so existing calls and edits continue to work.

### Retry and recovery

“Retry failed cells” is available in review actions and is the main action when only errors remain. It retries only errored cells, including document-preparation failures, and preserves successful, uncertain and unstarted cells. “Continue review” resumes unfinished work without repeating completed or uncertain answers. Explicit cell/document reruns and “Rerun all” still replace selected answers. Changed source documents invalidate prior answers.

After a server restart, running/queued cells and preparing documents return to an interrupted, resumable state. Recovery waits for the user to continue; it does not silently start paid requests. The table distinguishes document preparation, analysis and queued cells. Transient provider retries remain bounded and respect provider cooldowns.

Measured OCR/document-review acceptance is tracked separately in EIG-216; team library sync remains EIG-208.
