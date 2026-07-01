---
description: Open a PDF in the in-app viewer panel
---

Open a **PDF** so it appears in the app's viewer panel.

Resolve which PDF is meant from: `$ARGUMENTS`

1. **Resolve the path**: if the arguments name a file, find the real file in the
   workspace (glob for it if the path is partial; match case-insensitively). If no
   PDF is named, use the one most recently discussed or attached; if it's still
   ambiguous, list the workspace's PDFs and ask which one.
2. **Verify** the file exists and is a `.pdf`.
3. **Surface it**: write the file's workspace-relative path on its own line in your
   reply — that is what makes it appear as a clickable PDF artifact that opens in
   the viewer panel. The filename must be **plain** (no spaces or parentheses) to
   surface; if the name has spaces, make a plain-named copy (e.g.
   `Lease (final).pdf` → `Lease-final.pdf`), open the copy, and say why.

To act on the PDF instead of just viewing it, point the user at `/annotate`,
`/fill-form`, or `/sign`.
