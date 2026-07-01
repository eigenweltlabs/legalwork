---
description: Sign a PDF — stamp a signature block (name + date, or a PNG signature) on a signed copy
---

Sign a **PDF** — stamp a visible signature block (typed name + date, or a PNG
signature image) that the user reviews in the in-app PDF viewer. The original file
is never modified. This is a visible stamp, **not** a cryptographic signature.

Load and follow the **`pdf-tools`** skill, then carry out this request:

`$ARGUMENTS`

Reminders from the skill:

- The signer's **name is required** — if the arguments don't say who signs, ask;
  never sign with a guessed name. `--date` defaults to today.
- `inspect` the PDF first; the default placement is the bottom-right of the LAST
  page — pass `--page/--x/--y` (points, origin bottom-left) to hit an actual
  signature line instead.
- If the user provided a signature image, pass it with `--image` (PNG only).
- The `sign` subcommand writes `<name>.signed.pdf` next to the source.
- End your reply with the output **`name`** the tool returns on its own line so the
  signed copy surfaces as a clickable PDF artifact in the panel.

If no PDF is named in the arguments, ask which document to sign first.
