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

For reading, quoting, summarizing or comparing, call `read` with `path`.
For connected storage use `storage_read_file`. Neither requires loading this
skill, opening a viewer, inspecting fields or running a shell command.

- Choose combinable modes: `text: true` extracts embedded text, `ocr: true`
  explicitly recognizes pages, and `attach: true` sends PDF pages directly to a
  PDF-capable model for visual inspection. Ordinary reads default to embedded text
  only. OCR never runs automatically, and text/OCR never implicitly attach a PDF.
- `pages: [2, 3]` selects actual source pages; omitted means all pages.
  OCR processes at most 100 pages per call;
  attachments must fit 2 MB including base64 overhead. Oversized attachments return
  recovery instructions without sending PDF bytes: choose fewer pages or text/OCR.
- `pages_without_embedded_text` and `page_sources` report text-layer coverage.
  Missing embedded text does not establish a blank page: choose OCR or visual
  inspection for those pages. Embedded text also does not establish that images,
  handwriting and annotations were reviewed. Use OCR and/or attachment when needed.
- Choose a built-in PDF reading mode suited to the task: `text`, `attach` or `ocr`.
  If the first chosen mode fails or leaves a specific uncertainty relevant to the
  answer, such as missing page content or garbled, implausible or inconsistent
  information, use another applicable built-in PDF mode to resolve the affected
  content. Use shell only if the applicable built-in modes fail, are unavailable,
  or leave the relevant uncertainty unresolved. Stop once the information is clear
  and sufficient to answer.
- `offset` and `limit` (`max_chars` for storage) only paginate returned embedded/OCR
  text, never PDF pages, OCR work or attachment bytes. Follow `next_offset` with the
  same pages and modes when `truncated: true`. `complete` describes extraction
  coverage of selected pages, not whether all text was returned or the entire
  document reviewed. Report unreadable pages and OCR setup errors; do not repeat an
  unchanged failed call or claim missing content is absent. Never fabricate content.

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
