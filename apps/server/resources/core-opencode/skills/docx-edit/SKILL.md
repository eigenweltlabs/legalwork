---
name: docx-edit
description: >-
  Firm-owned Word (.docx) reading + editing. Use whenever the user wants to work with
  a Word document: read/answer questions about a contract ("what's the salary / term /
  governing law"), check a value against a threshold, redline or comment on a clause,
  or accept/adopt or reject tracked changes. Reads the FULL document — including clauses
  laid out in tables — and writes tracked-change redlines + comments as reviewable
  suggestions anywhere in the document. Three backends: the LegalWork in-app editor,
  the Microsoft Word add-in, and a self-contained file pipeline when no live document
  is open.
---

# Word (.docx) reading + editing

For a **due diligence report using the bundled Due Diligence template**, call
`legalwork_review_report_prepare` with the saved review IDs and original evidence
indexes. Read its bounded class files, write legal prose directly into the draft
JSON, and run `assets/report-from-reviews.py --project <project> --packet
<packet.json> --data <draft.json> --template <template.docx> --out
<reports/report.docx>`. The helper expands source references, verifies quotations,
builds the report tables and preserves the template in one operation. Findings use
`citations: [{sourceRef, page, quote}]`; a shared quotation can use
`citationGroups: [{reviewId, column, values, page, quote}]` to expand a saved answer
group internally. Each expanded citation is still checked. Open decisions remain
open. Follow the workflow's report instructions and field map. For a different
firm template, use the generic template population helper below. Do not generate
assembly scripts, read all source documents again, inspect
the template repeatedly, or turn routine report drafting into a second full review.

For **creating a new report from a supplied template**, use the deterministic
`assets/populate-template.py` helper instead of generating a Word-building script.
`python3 <skill>/assets/populate-template.py inspect --template <template.docx>`
returns the field keys and repeated-row tokens. Save the report content as JSON
`{"fields": {"token": "text"}, "tables": [{"tokens": ["id", "issue"], "rows": [{"id": "F-01", "issue": "Finding"}]}]}`,
then run `populate --template <template.docx> --data <content.json> --out <report.docx>`.
This preserves formatted runs, artwork, headers and repeated-row designs, supports
tokens split across runs, and fails on missing fields. Source/legal validation and
the editor's actual page count still require separate checks. It is for new file
creation; use the live editing backend for an already-open document.

For source-cited reports from a native Jev evidence export, use
`assets/verify-evidence.py --project <project> --index <evidence/index.json>
--register <register.json> --out <checks.json>` before treating quotations or
uncertainty dispositions as verified. It checks current source hashes and literal
page support, requires one citation per affected source, writes diagnostics to disk
and prints only counts. It does not verify legal conclusions or exhaustive scope.

This skill is how this firm reads and edits Word documents with AI. It has **three
backends**, and your FIRST step is always to pick the right one:

## Step 0: choose the target

For a named reference document that is not already open, inspect its saved file in the background with the FILE backend. Do not change the user's visible tab just to read a source. For an attached document to edit, first copy it to a visible project output with inapp_documents_open and copy_to. Keep the original attachment snapshot intact.


1. For reading source records, research, extraction or wiki imports, read connected documents directly with `storage_read_file` (default format). It returns Word text, source version and coverage without an in-app viewer, Word or shell. Follow `next_offset` for remaining text. Do not probe live surfaces for this task.
2. For the document the user is actively editing, use the matching live backend: `inapp_docx_read_document` in LegalWork, or `word_read_document` in Word. Preserve unsaved edits and use tracked changes.
3. For other workspace documents, use the FILE backend. An in-app viewer is not a prerequisite for file-based reading.

## IN-APP LIVE mode — edit the document open in LegalWork

- Read with `inapp_docx_read_document` or find exact text with `inapp_docx_find_text`.
  Start every new user edit request with a fresh live read. Do not reuse document
  identity, revision or paragraph handles from an earlier turn.
  Both return stable `paraId` anchors. Read_document reads the whole document by
  default. Pagination is optional via `limit`/`fromIndex`/`toIndex`; when paginating,
  follow `nextIndex` until coverage is complete. Use `view: "structure"`
  or `view: "formatting"`, or a `paraId`, for focused reads. Structure exposes native
  field codes/targets/missing-reference status, bookmarks, linked notes, controls
  and locks, section numbering and protection. Formatting exposes run/paragraph
  properties in points; `includeStyles` adds native definitions and inheritance.
- Each paragraph has a `location` with its area and container path. `main` is the
  ordinary text flow; table cells, floating text boxes and controls are separate
  areas, even when they are stored in the document body. `writingAreas` also
  identifies headers, footers and linked notes. For an unfamiliar template, start with `view: "layout"` for geometry, wrapping
  exclusions and formatting diagnostics. Images consume additional tokens. Use
  `inapp_docx_preview({page: 1})` only for a visual question or unresolved layout
  uncertainty, never for every document or after each edit. Its image is private
  to the agent. If it shows a defect, distinguish document formatting from a
  capture problem, fix supported defects and verify before finishing. Do not
  leave a known fixable defect with a suggestion to check Word. A box at the bottom of a page is
  not a suitable destination for ordinary letter content just because it is empty.
- Compose new letters or sections with `inapp_docx_edit` and an
  `insert_paragraphs` operation. Supply one object per real Word paragraph.
  `placement: "start"` or `"end"` always targets the main text flow.
  `"before"`, `"after"` or `"replace_empty"` requires a returned `paraId` and its
  `area`; `replace_empty` fills a blank template paragraph without deleting text.
  Example: `{operation: "insert_paragraphs", placement: "replace_empty",
  paraId: emptyMainParagraphId, area: "main", paragraphs: [{text: "Subject"},
  {text: "Dear recipient,"}, {text: "Letter content"}]}`. These are direct native
  edits and enforce protection. Do not compose an entire letter as one multiline
  `suggest_change` inside an arbitrary paragraph.
- For a new multi-paragraph draft, write in coherent sections of about 3 to 6
  paragraphs per native edit call. Start with the address, date and subject, then
  add the body and closing in subsequent calls. This lets the live editor tile
  show useful progress while you compose. Read fresh document identity, revision
  and anchors between calls and continue after the last paragraph you inserted.
  Keep a short edit in one call. The tile is the same live editor and does not
  require `inapp_docx_preview`, images or `show: true` to update.
- Edit existing wording with `inapp_docx_suggest_change`, with fresh
  `documentId`/`draftRevision`, `paraId` and its `area` from a live read or find.
  `area` defaults to `main`; explicitly choose a table, text box or control only
  when the requested edit belongs there. Add comments only when requested.
  Replace the smallest exact phrase that needs changing; retain surrounding language and formatting.
  Negotiated text edits are tracked changes and save back to the workspace automatically.
- For clean template population in a new output copy, use `inapp_docx_fill_template` with the exact placeholder and value. This accepts only the new replacement and preserves existing revisions.
- Native text controls can be filled by `controlId` or a unique `tag` through
  `inapp_docx_fill_template`, with fresh `documentId`/`draftRevision`. Locks and
  protection are enforced; structured/bound controls fail safely.
- Use `inapp_docx_edit` for typed `operations` batches: formatting, paragraph styles,
  bookmarks, linked cross-references, footnotes/endnotes, breaks, section numbering,
  protection and field/TOC refresh. These are direct native edits, not tracked
  proposals. Require `documentId`/`draftRevision` from a fresh live read. Operations
  run sequentially and save once; on failure inspect `appliedOperations`/`failedIndex`.
  Never replay applied edits. Re-read and use `action: "save"` without operations to
  retry a failed save. Note edits reload handles; put them last and read again.
- The operation names are `apply_formatting`, `set_paragraph_style`,
  `create_bookmark`, `insert_cross_reference`, `edit_cross_reference`, `edit_note`,
  `insert_note`, `insert_paragraphs`, `insert_break`, `set_page_numbering`, `set_protection`, `update_fields`.
  For a short linked reference use, for example,
  `{operation: "insert_cross_reference", paraId: sourceId, targetParaId: targetId,
  targetSearch: "§ 2 Schlussbestimmungen", kind: "text", search: "[REFERENCE]"}`.
  `search` replaces a unique source phrase (empty appends); `targetSearch` selects
  the native bookmark range in the target (omitting it references the paragraph).
  `create_bookmark` also accepts a unique `search` for a text range. Use an existing
  `bookmark` instead of `targetParaId`/`targetSearch` when one already matches.
  `kind: "number"` requires automatic numbering. A manually typed § label uses
  `kind: "text"` with `targetSearch`. Follow with `update_fields` and read back the
  native field instruction, linked status, target range and displayed result.
  When visibility is questioned, inspect structure and a real preview before
  claiming a rendering problem; do not add a duplicate unlinked text reference.
- `inapp_docx_compare_documents` compares the live draft with one saved returned
  project DOCX, or combines independent drafts into a new native redline copy.
  `inapp_docx_inspect_document` reads privacy findings; explicit `fileName`/`categories`
  create an outgoing copy. Removing revisions accepts all changes only in that
  copy. Copies preserve the live source and never overwrite files.
- Reply to requested partner comments with `inapp_docx_reply_comment` using the parent ID from `inapp_docx_read_comments`.
- Accept or revert edits with `inapp_docx_accept_changes` / `inapp_docx_reject_changes`.
  First call `inapp_docx_read_changes`, then pass the relevant IDs. For "revert my edits",
  reject only changes authored by the agent; never remove unrelated pre-existing redlines.
- Do the accept/reject action yourself when asked. Do not tell the user to click review
  controls or claim the live editor lacks the tool.
- Use the live tools for supported edits. For unsupported layout/structure, use
  `legalwork_shell` with `write: true`: it saves/releases/reloads project editors
  automatically. The explicit `inapp_docx_prepare_file_edit` remains for a manual
  multi-step handoff; proceed only after `ok` and `saved`, then reopen and verify.
  Negotiated redlines remain in the live draft; separate comparison/outgoing copies
  are created only when requested.
- Hand back one or two short sentences; the user can review the tracked change beside the chat.

## WORD LIVE mode — edit the open Microsoft Word document with word_* tools

- Read with `word_read_document` (and `word_search` to locate clauses) before editing,
  so anchors are verbatim.
- Edit with `word_replace_text` / `word_insert_text`: they apply native tracked changes
  directly in the open document. Keep rationale in chat unless comments are requested.
  `word_run_code` covers formatting and anything the typed tools miss.
- **Never write files in LIVE mode.** No `docx-agent.mjs`, no `.redlined.docx`, no copy
  of the open document. The redlines are already in front of the user: they accept or
  reject them in Word (Review ribbon). Do not tell them to open another file or the
  LegalWork viewer.
- Hand back: one or two short sentences on what you redlined and a reminder to review
  the tracked changes in Word.

## Editing judgment

- Keep redlines surgical: changing an amount, party, date, or placeholder should not rewrite the sentence or clause.
- Never place internal advice, missing-input notes or negotiation strategy into a deliverable unless requested. Summarize unresolved points in chat.
- For a new document populated from a template, preserve the template and create a clean output copy in the project. Do not deliver a template full of redlines unless requested. Preserve any pre-existing revisions; never accept unrelated changes to clean up your output.
- Save edited attachments and newly generated deliverables to visible project files, then link the exact output. Background reference attachments may remain unchanged in their attachment storage.

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
