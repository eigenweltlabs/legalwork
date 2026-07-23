---
name: docx-edit
description: >-
  Firm-owned Word (.docx) reading + editing. Use whenever the user wants to work with
  a Word document: read/answer questions about a contract ("what's the salary / term /
  governing law"), check a value against a threshold, redline or comment on a clause,
  or accept/adopt or reject tracked changes. Reads the FULL document — including clauses
  laid out in tables — and writes tracked-change redlines + comments as reviewable
  suggestions anywhere in the document. Two backends: inside the Word add-in it edits
  the OPEN document live via the word_* tools; otherwise it runs the self-contained
  file pipeline on the firm's own model and infrastructure, paired with the in-app
  .docx viewer.
---

# Word (.docx) reading + editing

This skill is how this firm reads and edits Word documents with AI. It has **two
backends**, and your FIRST step is always to pick the right one:

## Step 0 — where are you running?

- **LIVE backend (Word add-in).** The system prompt says you are working inside
  Microsoft Word and `word_*` tools are available. The document the user means is the
  one OPEN IN WORD → use LIVE mode below on it. (The FILE backend still applies to a
  *different* `.docx` in the workspace that is not open in Word.)
- **FILE backend (LegalWork app).** No Word pane is connected → use FILE mode below;
  the user reviews the output in the in-app `.docx` viewer.

## LIVE mode — edit the open document with word_* tools

- Read with `word_read_document` (and `word_search` to locate clauses) before editing,
  so anchors are verbatim.
- Edit with `word_replace_text` / `word_insert_text`: they apply native tracked changes
  directly in the open document. Attach a short `word_add_comment` rationale to each
  substantive edit. `word_run_code` covers formatting and anything the typed tools miss.
- **Never write files in LIVE mode.** No `docx-agent.mjs`, no `.redlined.docx`, no copy
  of the open document. The redlines are already in front of the user: they accept or
  reject them in Word (Review ribbon). Do not tell them to open another file or the
  LegalWork viewer.
- Hand back: one or two short sentences on what you redlined and a reminder to review
  the tracked changes in Word.

## FILE mode — the self-contained file pipeline

Everything below this point is the FILE backend. It is **self-contained**:
`assets/docx-agent.mjs` imports a vendored copy of the OOXML engine
(`assets/vendor/docx-engine.mjs`) — the same engine behind the in-app `.docx` viewer — so it
runs in any workspace with no install. **Do not hand-parse the document's XML with python** —
use this tool; it reads tables, tracked changes, and comments correctly, and edits as
reviewable tracked changes the lawyer accepts in the viewer.

## The tool

```bash
# Read the document (JSON). `paragraphs` is EVERY paragraph in order — body text AND
# table cells — each with a 0-based `index` and a `location` ("body" or "table, row R,
# col C"). `changes`/`comments` summarize existing tracked changes & comments.
node .opencode/skills/docx-edit/assets/docx-agent.mjs inspect "<file.docx>"

# Apply comments + tracked-change redlines (plan JSON on stdin). Writes <base>.redlined.docx.
echo '<plan-json>' | node .opencode/skills/docx-edit/assets/docx-agent.mjs apply "<file.docx>" --plan -

# Accept ("adopt") or reject ALL tracked changes, then write the clean result.
node .opencode/skills/docx-edit/assets/docx-agent.mjs accept-all "<file.docx>" --out "<file>.adopted.docx"
node .opencode/skills/docx-edit/assets/docx-agent.mjs reject-all "<file.docx>"
```

Writes `<base>.redlined.docx` (or `.adopted.docx`) next to the source by default — the original
is never touched. `--in-place` overwrites it; `--out` sets a path; `--author "Name"` stamps
the reviewer.

## The edit plan

`apply` takes a plan that maps directly onto the engine's batch API. **Anchor every edit by
the `index` from `inspect`** (the same index works for body paragraphs and table cells) and a
**verbatim `search`** copied exactly from that paragraph's `text`:

```json
{
  "author": "Eigenwelt Reviewer",
  "comments":  [ { "paragraphIndex": 181, "text": "Cap is low for this deal — propose €75k.", "search": "EUR 55,000.00" } ],
  "proposals": [ { "paragraphIndex": 181, "search": "EUR 55,000.00", "replaceWith": "EUR 75,000.00" } ]
}
```

- **`comments`** are margin notes (the *why*); they don't change text. `search` optional.
- **`proposals`** are tracked-change edits. `replaceWith:""` **deletes**; `search:""` **inserts**
  at the end of the paragraph; both non-empty is a **replacement**.
- **`search` must be VERBATIM** (an exact substring of that paragraph) or the op is dropped and
  listed in `errors`. This is also the safety net: a wrong `index` can't quietly edit the wrong
  clause — the search won't match, so it errors instead.

## Workflow

1. **Resolve the target** `.docx` (attached, `@path`, named, or in a folder). The engine handles
   OOXML Word (`.docx`, `.docm`, `.dotx`). For legacy `.doc/.odt/.rtf`, ask the user to save as `.docx`.
2. **`inspect`** and read the JSON. Most legal contracts lay every numbered clause inside a table —
   those cells are in `paragraphs` with `location: "table, row R, col C"`. Find the clause you need
   (e.g. the Remuneration clause for the salary) and note its `index`. Check existing `changes`/`comments`.
3. **Do what was asked. Read the verb first:**
   - **"edit / change / revise / redline / amend / rewrite / mark up / comment / draft"** →
     this means **PROPOSE NEW edits**. Find the relevant clause in `paragraphs` and `apply` a
     redline/comment anchored by its `index` + a verbatim `search`. **Do NOT start by looking at
     existing tracked changes** — a document having no tracked changes is NOT a reason to stop;
     you are there to *create* them. If the user said "edit" but didn't say *what* to change, ask
     what change they want (or read the doc and propose a specific one) — never reply "there are
     no tracked changes." For a full review pass, fan out the **`docx-redliner`** subagent (Task
     tool) with `FILE`, the `INSTRUCTION`, and the `paragraphs` list; it returns the plan JSON.
   - **"adopt / accept / finalize / reject the changes / clean up the markup"** → ONLY here do
     existing tracked changes matter. `accept-all` (or `reject-all`). If `inspect` shows zero
     changes, say so plainly — there's nothing to adopt; don't pretend.
   - **A question / threshold check** → answer from the inspected text and quote the clause.

   The existing-changes count in `inspect` is only relevant for the accept/adopt/reject case.
   Never treat "no existing tracked changes" as the answer to an *edit* request.
4. **Hand back:** state the output file by the **`name`** the tool returns (a plain, space-free
   filename — this is what makes it appear as a clickable Word artifact in the panel, exactly like
   a `.md`/`.csv`/`.html` the firm produces; a name with spaces/parens will NOT surface). Tell the
   user to open it in the in-app `.docx` viewer to review — tracked changes + comments render
   inline; they accept/reject there. (Inside the Word add-in there is no viewer: tell the user
   to open the output file in Word instead.) Don't pass a `--out` with spaces/parens. Summarize what you
   changed and **flag any `errors`** (ops whose `search` didn't match verbatim) and retry those
   with corrected text rather than dropping them.

## Guardrails

- **Read with the tool, not python.** The vendored engine sees tables, tracked changes, and
  comments that hand-rolled XML parsing misses, and gives you the exact `index` to edit by.
- **Non-destructive.** Edits are tracked-change suggestions; the human accepts/rejects in the
  viewer (FILE mode) or directly in Word (LIVE mode). In FILE mode default to a copy;
  overwrite in place only on request.
- **Never fabricate** a value, party, number, or a "done." If `search` won't match or there are no
  changes to adopt, say so.
- **Open models, firm-owned.** Don't hardcode a model; the `docx-redliner` subagent inherits the
  firm's configured model.
- **Distribution.** Bundled-core: seeded into every workspace via `core-skills.ts`
  (`scripts/gen-core-skills.mjs`), alongside the in-app viewer it feeds.
