# Tabular Review

Open in LegalWork: [Tabular Review settings](legalwork://app/settings/tabular-review), [Workflows](legalwork://app/workflows).

A Tabular Review applies the same questions to a collection of documents. Documents form the rows; questions form the columns. The native project page saves the table, answers and evidence so you can reopen and continue it. Ask the assistant to use the bundled `start-tabular-review` skill to create a native review.

## Create and run a review

1. Open the project's **Tabular Review** page and create a review, or ask the assistant to start a review of specific documents.
2. Add the source files. Check that they are the intended versions and belong to the right project.
3. Add questions as columns, or select a saved prompt set. Choose the expected answer type and clear instructions. For example, a yes/no question can ask whether an agreement permits assignment without consent; a text question can ask for the relevant wording.
4. Open review settings and check its mode and models. New reviews inherit **Settings > Tabular Review** defaults; an existing review keeps its own saved settings.
5. Start the review. Inspect document preparation, queued/active work and completed/error counts. The chat progress card opens the same saved review.
6. Open a result cell and its source evidence. Use table search and **Filter & sort** to narrow documents, answers or statuses. A plausible answer still needs review against its source.

## Modes and model settings

| Mode | What runs |
| --- | --- |
| Only JEV | Supported yes/no and fixed-choice decisions. Text extraction, arbitrary numbers and free-text explanations are not supported in this mode. |
| JEV + LLM | JEV handles supported decisions; the selected language model handles text questions. |
| Only LLM | The selected language model handles every question. |

Choose the JEV and/or LLM models required by the mode. The minimum answer probability determines when a decision needs attention. Missing models and incompatible questions produce an error rather than silently switching provider or region. **Use recommended defaults** restores the app's automatic choices for new reviews. These settings differ from the ordinary chat model.

## Evidence, OCR and incomplete answers

Scanned PDFs and images need document recognition. **Settings > AI Providers > Document recognition providers (OCR)** controls the recognizer. Preparation errors are distinct from an answer that found no relevant provision.

**Not found** is a completed absence result; **Needs review**, an error, an empty cell and a stale answer have different meanings. None should be silently counted as a negative answer or zero. JEV probabilities do not imply a supporting quotation exists. Where quotations are supplied, inspect the cited page and highlighted region. The source viewer's **Layout** control shows detected regions and reading order when available; detection is not proof that handwritten amendments or complex tables were understood.

Changing a source, question or model can mark previous answers out of date. Recheck the affected cells. Source-hash errors mean the evidence refers to another version, so open/reprepare the correct source instead of relying on old coordinates.

## Stop, continue and retry

Stopping preserves completed cells. **Continue review** resumes unfinished work. **Retry failed cells** retries errors while preserving other results. Explicit cell/document reruns and **Rerun all** replace the selected results. After an interrupted runtime, inspect the saved state and continue deliberately; recovery does not automatically start paid inference.

In a shared project, a review running on a colleague's computer is watched rather than run again locally. Its referenced documents are included when reviews are shared. See [Project sharing](projects-sharing.md).

## Reuse questions

In **Workflows**, open **Tabular Review Prompts**, then **Sets** or **All prompts**. Create questions, combine them into a set, or copy a built-in entry before customizing it. Editing a saved prompt creates a new version; existing reviews keep their copied questions. **Team** lists shared prompt sets; **Add to my prompts** installs a personal copy and **Update** refreshes that copy. Sharing a set does not share the reviewed matter documents.

Related: [Workflows](skills-workflows.md), [Models and OCR](models-fusion.md), [Files](files-documents.md).
