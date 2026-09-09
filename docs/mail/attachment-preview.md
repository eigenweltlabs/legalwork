# Stored attachment previews

Open uses the existing right-hand artifact panel, with one ephemeral mail source at a time. PDF, raster images, text/CSV/Markdown and original EML are read-only. DOCX has an explicitly labelled text preview from the existing document parser; formatting, annotations and tracked-change presentation require saving the original. Other Office formats, active/linked DOCX packages, SVG and HTML require explicit Save. Open never silently launches an external application.

Bytes come through authenticated, owner-scoped mail content reads with the existing 64 MiB cap and SHA-256 verification. A final current-message and attachment-reference check precedes publication. The reader signal retires the source on message/account/connection change or unmount. While open, a bounded check every five seconds also retires it on access failure or reference replacement. Blob URLs are revoked when the preview unmounts. Sources never become workspace files, query-cache entries or persisted panel tabs. Explicit Save keeps the existing native verified export flow.

DOCX preflight limits ZIP entries to 2,048, checks actual streaming expansion of every entry (16 MiB each, 64 MiB total), rejects active content and external relationships, and caps projected text at 8 MiB characters. This is intentionally more restrictive than the workspace editor: its read-only Word mode currently loads remote fonts. Mail previews do not invoke that editor.

Focused tests cover reference-safe opening into a separate viewer, source retirement and blob revocation, excluded persisted state, actual DOCX text parsing without network requests, encoded external relationships, and falsified ZIP expansion metadata. No live mailbox traffic is used.
