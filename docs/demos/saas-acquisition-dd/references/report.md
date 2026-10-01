# Report rules and draft format

The saved review results are the analytical starting point. Report preparation should normally consist of one native preparation call, reading the bounded class files, writing legal prose directly, one report-builder call and one saved/page-count check. Further calls should address a specific material gap or validation error. Do not generate assembly programs, repeatedly inspect template structure, dump all evidence or attempt to resolve every uncertain cell.

## Legal writing

Lead with the issues affecting signing, completion, ownership or operation of the business. State the source fact, its relevance to the described transaction, the uncertainty and the proposed action. Use restrained, complete sentences. Preserve document-level support in the register. Keep Jev, model names, confidence, tool/review IDs, cells, hashes, JSON and workflow mechanics out of the buyer's report and final chat.

The deliverable is a Draft requiring legal review. Apparent execution does not authenticate signatures. Silence or a missing supplied agreement does not prove non-existence. A source-matched quotation does not establish enforceability, statutory compliance, notarisation, unanimity or the correct SPA protection. Describe supported contractual issues and counsel's follow-up rather than inventing such conclusions. A consent on assignment does not necessarily apply to a share acquisition. Separate actual obligations, historical figures and proposed acquisition payments; do not estimate aggregates from prose. For material legal propositions use current primary authority; source inspection remains necessary where the compact review did not answer the issue.

Use Critical for a supported issue affecting title, completion, a key approval or material secured payoff; High for a material consent, termination exposure, uncapped liability or acquisition payment; Medium for a documentary/operational gap; Low for routine follow-up. Do not assign severity from confidence or a flag alone.

## Draft JSON

The native preparation tool writes `draft.json` with `fields`, `findings`, measured fields and the packet identity. Keep its identity and measured fields. Fill the narrative field values directly with write/edit. Coverage/count fields are derived from the native packet and cannot be changed by drafting. Fill total/excluded/retained input-file counts from the screening manifest, and explain any retained legal records outside the six reviewed classes. The template field map supplies every field name, so template inspection is unnecessary.

Add findings in this format:

```json
{
  "title": "Lender consent required before completion",
  "severity": "High",
  "impact": "Describe the supported contractual effect on the proposed acquisition.",
  "action": "Obtain the relevant written consent before completion.",
  "owner": "Seller",
  "timing": "Before completion",
  "citations": [{"sourceRef": "S00001", "page": 2, "clause": "Transfer", "quote": "An exact passage from that source page."}]
}
```

Use the actual source reference and exact passage, not this illustrative content. IDs are assigned by the helper; paths and hashes are resolved from the native packet. Use `affectedSources` only to add explicitly affected source references beyond the citations; each must have its own citation. An aggregate theme sharing a quotation can instead use:

```json
"citationGroups": [{"reviewId": "the saved review ID", "column": "the column key", "values": ["the exact accepted answer"], "page": 2, "quote": "The exact common passage."}]
```

The helper expands every accepted source in this group and checks the quotation against each source/page. It never includes uncertain answers. If language differs, use separate supported groups or material individual examples; do not pretend that one example resolves the entire group. Source-group memberships and full affected lists remain in the separate register rather than adding hundreds of rows to the report. Cite only quotations the supplied excerpts or targeted original files establish.

The helper creates the executive, risk and action tables from findings and preserves the full register. It shows up to 30 material themes and representative citation names in the Word report, keeping full citations separately. Class narratives explain measured themes and material implications rather than repeating each register entry.

## Outstanding questions and delivery

Keep native uncertain/blocked/error/stale decisions open in the supporting unresolved register. Summarise their material factual implications in the relevant class and outstanding-information sections. A draft can be delivered with truthful open questions; neither completion of the scheduler nor generation of a report clears them. Inspect and record a source-backed resolution only where needed for a material conclusion, preserving the original decision. Do not claim every cell or agreement is verified.

The original classification exports cover every input; the preparation tool supplies all six exact grids, manifests, full distributions and unresolved cells. These replace manually regenerated coverage, result and per-cell registers. Final checks are exact quotation/source support, measured scope, no unfilled tokens, a Word report saved in project reports, and an actual page count of at most 50. No visual review for this demo. The final chat is a short synopsis of the executive summary and the saved report link; no source codes or technical inventory.
