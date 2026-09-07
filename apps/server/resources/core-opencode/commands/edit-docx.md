---
description: Agentic Word editing — redline and comment on a .docx as reviewable tracked changes
---

Edit a **Word document** with AI — write back **comments and tracked-change redlines**
the lawyer reviews and accepts where they are working: directly in Microsoft Word when
this session runs inside the Word add-in, or in the in-app viewer otherwise (the firm's
open-model version of "ask the assistant to redline this contract").

Load and follow the **`docx-edit`** skill — **start with its Step 0** to pick the
backend. First try the document open in LegalWork's in-app editor and use
inapp_docx_* tools; otherwise try the Microsoft Word add-in and use word_* tools.
Only when neither live surface has the target document should you use the file
pipeline. Then carry out this request:

`$ARGUMENTS`

Reminders from the skill (FILE backend):

- `inspect` the `.docx` first to get the stable paragraph map; anchor every edit to a
  0-based `paragraphIndex`.
- For a full redline pass, fan out the **`docx-redliner`** subagent (Task tool); for a
  small targeted change, build the plan yourself.
- `comments` are margin notes (the *why*); `proposals` are tracked-change edits. Every
  `search` string must be **verbatim** from the paragraph.
- `apply` writes a non-destructive `<base>.redlined.docx` by default — open it in the
  viewer to see the redlines inline. Use `--in-place` only if asked.
- Report any ops that didn't match verbatim instead of dropping them; never fabricate
  parties, numbers, or terms.

If no document is named in the arguments, use the active in-app document or the
document open in Microsoft Word. Ask which `.docx` to edit only if neither is open.
