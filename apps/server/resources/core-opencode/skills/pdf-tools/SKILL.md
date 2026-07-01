---
name: pdf-tools
description: >-
  Firm-owned PDF actions over the in-app PDF viewer. Use whenever the user wants to
  act on a PDF: annotate it (sticky notes, highlight boxes), list or fill its form
  fields (AcroForm), or stamp a signature (typed name + date, or a PNG signature
  image). Always writes a NEW copy (.annotated.pdf / .filled.pdf / .signed.pdf) —
  the original PDF is never modified. Self-contained; runs on the firm's own
  infrastructure; pairs with the in-app PDF viewer.
---

# PDF actions (annotate / fill-form / sign)

This skill is how this firm annotates, fills, and signs PDFs with AI. It is
**self-contained**: `assets/pdf-agent.mjs` imports a vendored copy of pdf-lib
(`assets/vendor/pdf-lib.mjs`, MIT — pure JS, no native deps), so it runs in any
workspace with no install. **Do not hand-edit PDF bytes or reach for python** —
use this tool. Every command writes a **new file next to the source**; the
original PDF is **never touched**.

## The tool

```bash
# ALWAYS FIRST: page count, page sizes (points), and every form field
# (name / type / current value / options) as JSON.
node .opencode/skills/pdf-tools/assets/pdf-agent.mjs inspect "<file.pdf>"

# Sticky notes + highlight rectangles (plan JSON on stdin). Writes <base>.annotated.pdf.
echo '<plan-json>' | node .opencode/skills/pdf-tools/assets/pdf-agent.mjs annotate "<file.pdf>" --plan -

# Fill AcroForm fields from JSON key/values (stdin). Writes <base>.filled.pdf.
echo '{"Field Name":"value","Agree":true}' | node .opencode/skills/pdf-tools/assets/pdf-agent.mjs fill "<file.pdf>" --data -

# Stamp a signature block. Writes <base>.signed.pdf.
node .opencode/skills/pdf-tools/assets/pdf-agent.mjs sign "<file.pdf>" --name "Jane Doe" --date 2026-07-01
node .opencode/skills/pdf-tools/assets/pdf-agent.mjs sign "<file.pdf>" --name "Jane Doe" --image signature.png --page 3 --x 320 --y 90
```

**Coordinates:** pages are **1-based**; `x`/`y` are PDF **points** (1/72 inch, US
Letter is 612×792) with the **origin at the BOTTOM-LEFT** of the page; `(x, y)` is
the bottom-left corner of the note/highlight/signature. Get each page's size from
`inspect` before placing anything.

## Annotate — the plan

```json
{
  "annotations": [
    { "type": "note",      "page": 2, "x": 400, "y": 500, "text": "Cap is low for this deal — propose EUR 75k." },
    { "type": "highlight", "page": 2, "x": 70,  "y": 512, "width": 300, "height": 14 }
  ]
}
```

- **`note`** draws a yellow sticky note (text wraps automatically); `text` is required.
- **`highlight`** draws a translucent box over existing text; `width` is required,
  `height` defaults to 14 (one text line).
- Optional `color` is `"#RRGGBB"`. A bad page/coordinate fails with a clear error
  instead of writing a broken file.

## Fill-form

`inspect` first — fill by the **exact `name`** it reports. Values by field `type`:
`text` takes any string, `checkbox` takes true/false, `dropdown` / `option-list` /
`radio-group` take **one of the listed `options`** (anything else is skipped with the
valid options in the reason). The result lists `filled` and `skipped` (each skip has a
`reason`) — report skips and retry with corrected names/options rather than dropping them.

## Sign

`--name` is required; `--date` defaults to today. Default placement is the
**bottom-right of the LAST page** — pass `--page/--x/--y` to place it elsewhere (e.g.
on the signature line `inspect` showed you). With `--image sig.png` the PNG is drawn
above the signature rule instead of the typed name (`--image-width` scales it,
default 140pt). This is a visible signature stamp, not a cryptographic signature.

## Workflow

1. **Resolve the target PDF** (attached, `@path`, named, or in a folder). If the user
   points at a scan, remember highlights cover images fine, but form-fill needs real
   AcroForm fields — `inspect` reports `fields: []` for flat PDFs; say so and offer
   annotations instead.
2. **`inspect`** and read the JSON: page sizes for placement, field names/options for
   filling.
3. **Run the action** (`annotate` / `fill` / `sign`). The tool refuses to overwrite
   the source; output goes to `<base>.annotated.pdf` / `.filled.pdf` / `.signed.pdf`
   next to it (`--out` to change).
4. **Hand back:** state the output file by the **`name`** the tool returns (a plain,
   space-free filename — this is what makes it appear as a clickable PDF artifact in
   the panel). Tell the user to open it in the in-app PDF viewer, summarize what you
   did, and **flag any `skipped`** entries with their reasons.

## Guardrails

- **Non-destructive.** Never modify the source PDF in place; there is deliberately no
  `--in-place`.
- **Never fabricate** form values, names, or dates — ask when a value is missing.
- **Encrypted/broken PDFs** fail with a clear message; relay it, don't work around it.
- **Distribution.** Bundled-core: seeded into every workspace via `core-skills.ts`
  (`scripts/gen-core-skills.mjs`), alongside the in-app PDF viewer it feeds.
