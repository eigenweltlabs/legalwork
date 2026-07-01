---
description: Annotate a PDF — sticky notes and highlights, written to a reviewable copy
---

Annotate a **PDF** with AI — sticky notes and highlight boxes the user reviews in
the in-app PDF viewer. The original file is never modified.

Load and follow the **`pdf-tools`** skill, then carry out this request:

`$ARGUMENTS`

Reminders from the skill:

- `inspect` the PDF first for the page count and page sizes; pages are 1-based and
  coordinates are PDF points with the origin at the **bottom-left**.
- Build one plan JSON (`{ "annotations": [...] }`) with `note` and `highlight`
  entries, then run the `annotate` subcommand — it writes `<name>.annotated.pdf`
  next to the source.
- End your reply with the output **`name`** the tool returns on its own line so the
  annotated copy surfaces as a clickable PDF artifact in the panel.
- Report anything the tool rejected (bad page/coordinates) and retry with corrected
  values instead of dropping it.

If no PDF is named in the arguments, ask which one to annotate first.
