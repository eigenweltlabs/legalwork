---
name: tabular-review
description: >-
  Firm-owned tabular document review — the open-model replacement for Harvey/Legora
  "review grids". Extract a defined set of fields (columns) across a set of documents
  (rows) and produce an interactive, source-cited review table. Use whenever the user
  wants to review/compare/extract across MANY documents at once: due-diligence pulls,
  NDA/contract abstraction, lease abstraction, "make a table of X across these files",
  "review these contracts for Y", "build a review grid", or "extract these terms from
  every document".
---

# Tabular Review

This skill is how this firm runs **tabular document review** — the workflow Harvey and
Legora call a "review grid": documents are **rows**, the fields you care about are
**columns**, and each cell contains a cited LLM extraction or an explicitly uncited
SystemOne decision. Unlike the
SaaS versions, this runs on the firm's own models and infrastructure, the column logic
lives in firm-owned **doctype skills**, and the output is a self-contained artifact the
firm keeps.

You are the **orchestrator**. Define the grid, discover and select the review model,
prepare each document (optionally with one `document-extractor` subagent per file),
call the review tool, and assemble the returned rows into one HTML artifact.

## The shape of the job

```
                 Parties     Term      Governing law   Assignment ...   ← columns (fields)
  acme_nda.pdf   [cell]      [cell]    [cell]          [cell]
  beta_msa.pdf   [cell]      [cell]    [cell]          [cell]      ← rows (documents)
  ...
```

For LLM extraction, each cell = a short `value` (what shows in the grid) plus, behind a click, a longer
`reason`, one verbatim `quote` sentence, and the cited PDF `page` rendered with that
sentence highlighted. Every value is grounded in source evidence. Use "Not found" only after complete
extraction; incomplete or unreadable evidence is "Needs review". No hallucinated cells.

---

## Workflow

### 1. Resolve the document set (rows)

Find the files to review. They may be attached, referenced by `@path`, named in the
prompt, or sitting in a folder ("review the NDAs in `./ndas`"). Use `glob`/`list` to
expand folders. Confirm the list with the user if it's ambiguous or large (>~20).

Sniff the **document type** of each file (from filename and, if cheap, a first-page
peek). You'll use this both to pick columns and to tell each extractor what it's looking
at. A set can be mixed (some NDAs, some leases) — that's fine; group by type.

### 2. Resolve the columns (fields) — THIS IS THE BRANCH POINT

Columns can come from three places, in priority order:

1. **The user already specified them.** ("Extract party names, term, and governing
   law.") Use those verbatim; only add a column if you ask first.
2. **A loaded doctype skill.** Look for a skill named `doctype-<type>` (e.g.
   `doctype-nda`, `doctype-commercial-lease`). If one matches the documents, **load it
   with the `skill` tool** and use its recommended columns as the default set. List
   available skills first if unsure what exists.
3. **Neither → ASK THE USER. Do not invent a column set silently.** Detect the doc
   types, then ask what to extract and **propose a starter set based on those types**,
   using the suggestion library below. Make it a one-tap decision: offer the suggested
   columns and let them add/remove. Example:

   > These look like **mutual NDAs**. What should I pull into the review table? A common
   > starting set for NDAs: **Parties · Effective date · Term · Purpose · Definition of
   > Confidential Information · Exclusions · Permitted disclosures · Return/destruction ·
   > Governing law · Term of confidentiality**. Want this set, a subset, or your own
   > columns?

   If the documents are mixed types, suggest the union and note which columns apply to
   which type.

Normalize the final columns into objects you'll pass down and render:
`{ key, label, question, hint? }` — `key` is a short slug (`governing_law`), `label` is
the header (`Governing law`), `question` is the precise instruction the extractor
answers, `hint` is optional (format/where to look).

### 3. Prepare PDFs and images, then fan out

Before starting document extractors, call **`legalwork_document_prepare` once with
all PDF, PNG, JPEG and WebP paths for this run**. This freezes the OCR model selected
in Settings → AI Providers across the review. Omit language hints unless known;
never assume that documents are English or German. DOCX/text use their existing readers.

Poll `legalwork_document_preparation_status` with the returned ID while preparation
is queued/running. Tell the user the selected model and actual document/page progress;
space status checks several seconds apart. On cancellation, call
`legalwork_document_preparation_cancel`. A later prepare call reuses completed pages;
`force: true` explicitly repeats OCR, including previously cached uncertain pages.

Every PDF page is rendered and OCRed, including pages with native text. Native text
and OCR stay separate; the presence of a text layer does not rule out handwriting.
The tool returns one workspace-relative **`preparationPath`** per prepared document.
Pass it as `PREPARATION` to that document's extractor. Keep that path on its output row.
If preparation cannot start (e.g. model not installed), report the actionable tool
error. If it fails for a file, retain the row as **Needs review**, with
`preparationError` containing the failure. Do not silently use only native text or
switch models. Never interpret a failed/unreadable page as proof a clause is absent.

### 4. Choose a backend and model, then review each document

Call **`tabular_review_models`** first. It returns available `llm` and `systemone`
models with `providerId`, `model`, supported `questionTypes`, and `citations`.
Discovery errors mean availability is unknown; do not invent a model or silently
switch backends. Honor the user's model/backend choice. Otherwise choose:

- **`llm`** for free-text extraction (parties, dates, clauses) or cited explanations.
- **`systemone`** for JEV-like typed decisions: yes/no probability (`noul`), fixed
  choices (`choice`), or ordered rubric scores (`score`). Every column needs a
  `decision` using that model's advertised question types. It cannot extract free
  text, quotes, or reasoning. If citations are required, choose an LLM.

For mixed free-text/decision columns, use an LLM for the grid unless the user asks
for separate passes. Do not silently rewrite a free-text question into a decision.
Do not ask the user which question types a provider supports: discovery supplies it.

For each document, call **`tabular_review_row`** with `backend`, `providerId`,
`model`, `file`, `title`, `docType`, and `columns`.

- PDF/images: pass `preparationPath` from step 3. The tool loads and validates the
  prepared evidence, preserving native text, OCR text, page numbers and regions.
  Omit `pages`; do not replace OCR evidence with a text-only PDF extraction.
- DOCX: use `node .opencode/skills/docx-edit/assets/docx-agent.mjs inspect "<file>"`
  and supply complete `pages: [{page: null, text}]`.
- Text: read the complete file and supply `pages: [{page: null, text}]`.

Never summarize or truncate the source. Incomplete preparation prevents SystemOne
review; retain a Needs review row and report the preparation error. LLMs may cite
found passages on uncertain pages, but must not claim an absent term is Not found.

Example SystemOne column:
```json
{"key":"assignment","label":"Assignment allowed","question":"May the agreement be assigned without consent?","decision":{"type":"noul","instructions":"Answer using the whole agreement, including exceptions.","criteria":{"true":"Assignment without consent is expressly allowed.","false":"Consent is required or assignment is prohibited or not addressed."}}}
```
For `choice`, supply `criteria` as named options mapped to descriptions (include an
absent/unclear option where appropriate). For `score`, supply 2–10 ordered criteria.
The tool returns `{ok:true,row}` with a **cells map** and `review` provenance. Keep
all returned metadata, probabilities, usage and actual serving model in the data file.
A failure returns `{ok:false,error}`: retain the document with visible Error cells,
and report the error. Do not retry using a different model without an explicit choice.

SystemOne cells are **uncited model decisions**, not verified extractions. Preserve
`confidence: null`, `evidence: "uncited"`, and `decision`. Never invent quotes, pages,
reasoning, or convert probability to high/medium/low extraction confidence.
The artifact labels these decisions and shows their distribution.

### 4a. Delegate document preparation when useful

For many files, delegate one document to each `document-extractor` with the selected
`BACKEND`, `PROVIDER_ID`, and `MODEL`, plus `PREPARATION` for PDF/images and the columns (including any `decision`).
In this mode the extractor reads the source and calls `tabular_review_row`, returning
its row unchanged. The model performing the review is the explicitly selected model;
the preparation agent must not replace its answers.

Cells may include `citations: [{page, quote, source: "native"|"ocr", regionIds?: [0, 1]}]`.
Preserve ALL citations, including those on different pages; region IDs are zero-based
indexes into that page's OCR regions. Do not invent rectangles. The builder reads the
preparation file, checks source hashes and quotes, and resolves region coordinates.
A model without regions still gets a page-level citation. Incomplete extraction or
unverifiable quotes must not become a clean "Not found" result.

### 5. Collect and assemble the data file

Use the tool's `row` directly and keep its `review` provenance and cells map.
If a tool fails or a preparation subagent errors, keep the row with that file's cells set to `value: "Error"`,
`confidence: "low"` — never drop a document silently; the grid must account for every
file. Tool rows already use a cells map keyed by column key.

Write a data file `<matter-slug>-review.data.json` in the workspace with this shape.
Give each row BOTH paths so the viewer works in the app and when opened from disk:
- **`file`** — the **workspace-relative** path (e.g. `ndas/acme.pdf`). The in-app viewer
  asks the app for this file over the bridge, so it must be workspace-relative.
- **`fileAbs`** — the **absolute** path on disk (e.g. `/Users/.../ndas/acme.pdf`). Used
  for the "open the PDF at this page" link when the saved `.html` is opened standalone.

```json
{
  "preparationRequired": true,
  "matter": "<short matter/review name>",
  "generatedAt": "<current ISO 8601 timestamp>",
  "columns": [ { "key": "...", "label": "...", "question": "..." } ],
  "rows": [
    {
      "file": "ndas/acme.pdf", "fileAbs": "/abs/path/to/ndas/acme.pdf",
      "preparationPath": ".opencode/legalwork/prepared-documents/<key>.json",
      "title": "...", "docType": "...", "summary": "...",
      "cells": {
        "<key>": { "value": "<short>", "reason": "<longer>", "quote": "<one sentence>", "page": 3, "location": "§7.2", "confidence": "high", "citations": [{ "page": 3, "quote": "<one sentence>", "source": "native" }] }
      }
    }
  ]
}
```

### 6. Build the artifact (run the builder — do NOT hand-write the HTML)

Run the bundled builder. It injects a pdf.js viewer + the Eigenwelt theme + your JSON and
writes a `.html` artifact. **No PDF is embedded** — the artifact loads each source PDF
dynamically from its local file at view time and highlights the `quote` string on the
cited `page`. So the artifact is a small, fixed size no matter how many or how large the
source documents are.

```bash
node .opencode/skills/tabular-review/assets/build-review.mjs "<matter-slug>-review.data.json" --out "<matter-slug>-review.html"
```

(If your CWD is the skill dir, adjust the path; the builder also accepts `--template` and
`--vendor` overrides.) The builder is deterministic — you just produce good JSON.

Writing the `.html` makes the app surface it automatically as a previewable HTML artifact
(sandboxed iframe, scripts enabled): the grid shows the short `value` per cell; clicking a
cell opens a liquid-glass sidebar with the `reason`, the verbatim `quote`, and a **pdf.js
viewer** that opens the source PDF to the cited page with the sentence highlighted (with
page navigation). Filter and CSV export are built in.

How the viewer reads the local PDF (no embedding):
- **In the app**: the viewer asks the app for the file bytes over a postMessage bridge
  using `row.file` (workspace-relative), and renders + highlights inline.
- **Opened standalone from disk (`file://`)**: browsers block pages from auto-loading
  local files, so the viewer shows an **Open page N in the PDF** link (built from
  `row.fileAbs`) that opens it in the native viewer, plus a file picker to load it into
  the highlighting viewer. This is why `fileAbs` matters — without it that link is dead.
- No poppler or other system tools are required — pdf.js renders in the browser.

### 7. Summarize in chat

After building the artifact, give a short readout: how many documents × columns, the name
of the artifact file, and — most useful to a lawyer — the **exceptions**: cells that came
back `low` confidence, conflicts, "Not found" where you'd expect a value, and any
`reason` worth surfacing (auto-renewals, unusual carve-outs, missing signatures). The
table is for scanning; your summary is for triage.

---

## Column suggestion library (used in step 2.3 when no doctype skill is loaded)

Starter columns by document type. Offer these as the proposed set, then let the user
edit. Prefer a loaded `doctype-*` skill over this list when one exists.

- **NDA / confidentiality agreement** — Parties · Mutual or one-way · Effective date ·
  Term · Purpose · Definition of Confidential Information · Exclusions · Permitted
  disclosures · Return/destruction · Term of confidentiality · Governing law · Injunctive
  relief.
- **Services / MSA / SOW** — Parties · Effective date · Term & renewal · Services/scope ·
  Fees & payment terms · Termination rights · Liability cap · Indemnification · IP
  ownership · Warranties · Governing law.
- **Employment agreement** — Employee · Employer · Start date · Title/role · Compensation ·
  At-will vs term · Non-compete · Non-solicit · Confidentiality · Severance · Governing law.
- **Commercial lease** — Landlord · Tenant · Premises · Commencement date · Term ·
  Base rent · Escalations · Renewal options · Security deposit · Permitted use ·
  Assignment/sublease · Maintenance (CAM) · Governing law.
- **Purchase / M&A agreement (SPA/APA)** — Buyer · Seller · Target/assets · Purchase
  price · Closing date · Conditions to closing · Reps & warranties survival ·
  Indemnification cap/basket · Non-compete · Governing law.
- **Loan / credit agreement** — Borrower · Lender · Principal · Interest rate · Maturity ·
  Repayment schedule · Collateral/security · Financial covenants · Events of default ·
  Governing law.
- **Unknown / mixed** — Document type · Parties · Effective date · Term · Key obligations ·
  Termination · Governing law · Notable risks. (Then refine with the user.)

---

## The doctype-skill convention

A **doctype skill** is a normal skill named `doctype-<type>` whose job is to define the
review columns (and where to look) for one kind of document. When the firm reviews a new
document type often, capture its column logic as a `doctype-*` skill so this orchestrator
can load it automatically instead of asking every time. Each one should provide a
`## Columns` section: a list of `key`, `label`, `question`, and a `where to look` hint.
Example packs (`doctype-nda`, `doctype-commercial-lease`, …) live in the **LegalWork
Hub** — a firm installs the ones it needs from Settings → Extensions → Skills. If none
is installed, the suggestion library above is the fallback.

## Notes & guardrails

- **Open models, firm-owned.** Don't hardcode a model — discover the firm's
  available models and use the chosen model explicitly. The value here is that the column logic and corrections stay in the
  firm's skills and artifacts.
- **Never fabricate a cell.** A blank, source-cited grid beats a confident wrong one.
  This is the one bar that matters; everything else is convenience.
- **Account for every file.** Each input document is exactly one row, even on error.
- **Scale check.** Many files × parallel subagents is fine, but if the set is very large
  (say >30), confirm scope with the user and consider batching.
