# Native project Tabular Review

Tabular Review is a saved project page backed by the server review service. Users select project documents, add typed questions or saved prompt sets, and run a persistent table. Agent-created reviews use the same service and appear in the same page, with live chat cards that open the review.

## Execution settings

The user selects the mode and models in Review settings. Agent tools can read these settings but cannot change them or pass an alternate backend into creation, editing or execution.

| Mode | Review inference |
| --- | --- |
| Only JEV | Yes/no predicates and fixed-choice classification only. Preserve probabilities. No LLM inference, free-text explanations, score questions or fabricated citations. |
| JEV + LLM | JEV for yes/no and classification; the selected LLM for text questions. |
| Only LLM | The selected LLM for every question, including context assessment. No JEV inference. |

New reviews default to mixed mode when an eligible JEV provider is ready; otherwise they start with LLM mode. Explicit saved choices remain unchanged if a provider disappears. Missing models, provider errors and incompatible columns produce errors rather than a fallback. The editor and backend reject text columns and explicit extraction/explanation instructions mislabeled as JEV decisions. Fixed output schemas remain enforced at inference; lexical question checks do not prove arbitrary natural-language intent.

## Evidence and recovery

PDFs and images use the shared document-preparation service. Each run pins one OCR configuration for its selected documents. Native text, OCR text and region references remain distinct. DOCX extraction includes body, headers, footers, comments and notes; drawings and tracked changes are marked as uncertain.

The context splitter follows the demo's overlapping, paragraph/sentence-aware windows. Relevant passages are combined for the final answer within the selected model's context limit. Insufficient relevance, incomplete recognition or supporting passages that cannot fit together produce **Needs review**, rather than an absence claim. JEV answers expose probabilities without pretending that JEV returned quotations. LLM quotations are checked against the prepared evidence.

Results keep the executed prompt, model, source hash and evidence references. Source citations revalidate the file and open its original page in the existing right panel, highlighting validated OCR regions where available. Stale files require a rerun. Users can stop, resume or rerun selected cells. A restarted server marks unfinished runs as interrupted and retains completed answers. Billing/authentication failures stop promptly instead of leaving the grid in an endless provider retry.

## Prompt library

The library contains English/German starters, individual saved columns and named sets. Personal names and prompts remain literal in either language. Users can inspect the complete questions/options, save and edit entries, and explicitly update copied columns. Each edit creates a new version; existing review snapshots and results stay unchanged until updated. Agent tools can discover, read, save and reuse the same definitions. Sharing across firms remains part of the existing sync/sharing work.

## Legacy migration

The bundled `tabular-review` artifact skill, HTML builder and `tabular_review_row` / `tabular_review_models` registrations are removed. The shared PDF reader retains its PDF.js assets under `pdf-tools`.

On startup, obsolete project skill/command folders are moved into `.opencode/legalwork/retired-reviews`, outside skill discovery. Shared-library copies move to `legalwork-retired-reviews` beside the skills directory. Customized files are preserved. Exact app-generated workflow wrappers migrate to saved-review tools while keeping the user's column definitions. Existing HTML result files remain readable.

## Verification and remaining acceptance

Focused automated checks cover execution policy, model selection, no fallback, prompt versions, source boundaries, citations/regions, context offsets, idempotent starts, cancellation, restart recovery, pinned OCR and legacy migration. English/German keys and app/server type checks are included. Desktop registration now preserves server-created projects across relaunch.

Electron checks on 25 September 2026 verified project/review creation, document selection, library import/save/edit, German screens/date formatting and local OCR installation. An explicitly labeled UI fixture verified opening the original source page and its selected region; this was not a model result. The higher-quality local model completed its built-in sample. This is a setup smoke check, not handwriting or diligence accuracy acceptance. The real LLM attempt correctly exposed the account's billing error in its cells and stopped retrying.

Real review inference remains unaccepted on this Mac: the restricted JEV development credential is missing, and the configured OpenAI account reports no API credits. See `systemone-dev.md` for the local gateway/proxy setup. Do not substitute a mock result as real-model acceptance.

EIG-210 remains open for the labeled multilingual OCR/DD evaluation, split and handwritten clause recall/false-positive measurements, hardware/resource measurements and real JEV/mixed-mode acceptance. Search reuse is tracked in EIG-211 and final sprint-wide UX acceptance in EIG-214. Production EigenJev rollout remains EIG-209.

Focused commands:

```sh
pnpm --filter legalwork-server exec bun test src/reviews src/document-preparation/citations.test.ts src/opencode-plugins/legalwork-review-tools.test.ts src/workspace-init.test.ts src/opencode-plugins/legalwork-skill-tools.test.ts
pnpm --filter @legalwork/app exec bun test tests/workflow-editor.test.ts tests/tool-runs.test.tsx
node --test apps/desktop/electron/workspace-store.test.mjs
pnpm --filter @legalwork/app typecheck
pnpm --filter legalwork-server build
pnpm --filter @legalwork/app exec bun scripts/i18n-check.ts
```
