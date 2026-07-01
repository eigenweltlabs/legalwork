---
description: Fill a PDF form — list its fields and write the values to a filled copy
---

Fill a **PDF form** (AcroForm) with AI — the user reviews the filled copy in the
in-app PDF viewer. The original file is never modified.

Load and follow the **`pdf-tools`** skill, then carry out this request:

`$ARGUMENTS`

Reminders from the skill:

- `inspect` the PDF first — it lists every form field's exact `name`, `type`,
  current value, and (for dropdowns/radios) the valid `options`. Fill by those
  exact names; choice fields only accept one of their listed options.
- Run the `fill` subcommand with one JSON object of `{ "fieldName": value }` — it
  writes `<name>.filled.pdf` next to the source.
- If `inspect` shows `fields: []`, the PDF has no fillable form (likely a flat
  scan) — say so plainly and offer `/annotate` instead; don't pretend to fill it.
- Never invent a value the user didn't give — ask for anything missing.
- Flag every `skipped` entry with its reason and retry with corrected names/options.
- End your reply with the output **`name`** the tool returns on its own line so the
  filled copy surfaces as a clickable PDF artifact in the panel.

If no PDF is named in the arguments, ask which form to fill first.
