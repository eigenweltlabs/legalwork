---
name: pdf-tools
description: >-
  Firm-owned PDF editing actions. Use when the user wants to
  annotate a PDF (sticky notes, highlight boxes), list or fill its form fields (AcroForm),
  or stamp a signature (typed name + date, or a PNG signature image). Editing always
  writes a NEW copy (.annotated.pdf / .filled.pdf / .signed.pdf) — the original PDF is
  never modified. Self-contained; runs on the firm's own infrastructure; pairs with
  the in-app PDF viewer. For reading, quoting, summarizing or comparing PDFs, use
  read or storage_read_file directly; this skill is not required.
---

# PDF actions (annotate / fill-form / sign)

This skill is how this firm annotates, fills, and signs PDFs with AI. It is
**self-contained**: `assets/pdf-agent.mjs` imports vendored engines (pdf-lib for
actions, pdf.js for text — pure JS, no native deps), so it runs in any workspace
with no install. **Do not hand-edit PDF bytes or reach for python or `pdftotext`**
(they may not exist on the machine) — use this tool. Every editing command writes
a **new file next to the source**; the original PDF is **never touched**.

## The tool

```bash
# Before editing: page count, page sizes (points), and every form field
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

## Read PDFs and scans

For reading, quoting, summarizing or comparing, call `read` with `filePath`.
For connected storage use `storage_read_file`. Neither requires loading this
skill, opening a viewer, inspecting fields or running a shell command.

- PDF-capable models always receive the original PDF, including scans. The provider
  handles its embedded text and page images; do not extract text or run OCR first.
- Other models receive embedded text when available. Only pages without text use
  the configured OCR service automatically. Images, logos and annotations alone
  do not trigger OCR.
- Request `ocr: true` when the user explicitly asks for OCR or relevant visual
  additions need recognition. Optionally pass `pages: [2, 3]` to limit the work.
  PDF-capable models still receive the original PDF alongside explicit OCR text.
- Text results report page coverage, errors and `next_offset`. Follow that offset
  for more text. `page_sources` identifies which pages used OCR; a document-level
  `extraction: "ocr"` does not mean every page was OCR'd.
  A page without embedded text is not an empty document. Report
  unreadable pages or OCR setup errors; do not repeat the same failed call or
  claim missing content is absent. Never fabricate content.

The legacy script's `text` subcommand extracts embedded text only. It is not the
document reader and cannot establish that a scan is unreadable.

## Workflow

1. **Resolve the target PDF** (attached, `@path`, named, or in a folder). If the user
   points at a scan, remember highlights cover images fine, but form-fill needs real
   AcroForm fields — `inspect` reports `fields: []` for flat PDFs; say so and offer
   annotations instead.
2. **`inspect`** and read the JSON: page sizes for placement, field names/options for
   filling. To read the document itself, use **`read`**.
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
