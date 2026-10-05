# Report preparation

Use the matter's language and firm conventions. Describe supported facts and their significance for the review purpose. Keep legal conclusions distinct from extraction: a quotation does not establish enforceability, statutory compliance or a closing requirement. Check current primary authority when a material legal proposition requires it. Do not infer non-existence from missing documents or authenticate signatures from apparent execution wording.

## Attached template

The attached Word template has general sections for executive summary, implications, scope, findings, outstanding questions, actions and qualifications. It has no prescribed industries, document classes or review libraries. All matter details are editable fields.

1. Copy `references/template-fields.json` from this workflow to `reports/dd-report-data/template-fields.json`.
2. Pass that project-relative field map as `templateFields` to `legalwork_review_report_prepare`, with `outputPrefix: "reports/dd-report-data"`. The tool saves the native packet, bounded class files, a draft and supporting exports.
3. Read the class files and write the draft's `fields` and `findings` directly with write/edit. Preserve its packet identity and native measured fields. Take supplied/excluded/retained counts from screening. `unresolved_files` means documents with at least one outstanding review question, not unsigned documents or material risks.
4. Run the bundled helper once, from the project directory:

```sh
python3 .opencode/skills/docx-edit/assets/report-from-reviews.py --project . --packet reports/dd-report-data/packet.json --data reports/dd-report-data/draft.json --template "<workflow>/resources/DD-Report-Template.docx" --out reports/DD-Report.docx
```

Resolve `<workflow>` from the loaded skill's actual location. The helper creates the repeated tables, checks quotations and current source hashes, and saves the report and supporting registers. Do not generate assembly programs. Correct a specific validation error in the prose or evidence and rerun the helper when needed.

Each material finding has `title`, `severity` (Critical, High, Medium or Low), `impact`, `action`, `owner`, `timing`, and `citations: [{sourceRef, page, quote, clause}]`. Use source references from the packet and exact quotations from supplied evidence. For an aggregate with identical source language, `citationGroups: [{reviewId, column, values, page, quote}]` expands accepted native answers internally and verifies each source; uncertain answers remain excluded. A representative example alone does not substantiate a claim about every member of a class.

Keep the report proportionate to the matter. The default builder shows up to 30 material themes in its tables and retains the full register separately. Explain class-level themes in the narrative; use an agreed alternative structure if more detail must appear in the report. State actual limitations and open questions. An outstanding question does not become resolved merely because the report was generated.

## A firm's own template

A supplied template takes precedence. Use `docx-edit` to inspect its fields once, map the report content to its actual structure, and use its template population helper. Do not force the default template's field names or repeated tables onto a different design. Reuse the native packet and verify source quotations with the bundled evidence helper; preserve the original template. For a template without replacement fields, use the documented Word editing tools on a copy rather than inventing a Word assembly script.

## Final checks

Verify measured scope, quotations and current source versions; retain unresolved decisions. Confirm there are no unfilled fields and that the Word file is saved in the project. Read saved status and actual page count from the editor, using compact metadata when available. Keep the final chat to the material conclusion, immediate next steps and the report link.
