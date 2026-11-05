# In-app Office saved outcomes

Prepare one frozen controller suite for both isolated application arms:

```sh
node scripts/benchmarks/prepare-office.mjs --output /private/new-office-fixtures
```

Only `inputs/settlement.xlsx` and `inputs/briefing.pptx` enter the guest, through
the suite's `copyFiles`. The generator, expectations, source identities, JSON
suite, receipts, saved-file parsers and tool journal remain on the controller.
Preparation does not modify installed skills, select a model, call inference or
establish application parity.

The workbook already has two named sheets and a sufficiently large grid. The
task applies a principal from the second sheet and adds three formulas within
that grid. Saved-file criteria require the formulas and actual numeric caches,
recalculation of existing dependent/cross-sheet formulas, original sheet order,
unrelated cells, number formats, styles and theme. Correct-looking constants or
stale cached numbers fail. Structural sheet edits are outside this existing
in-app editor capability; the external Microsoft add-in profile covers them.

The presentation has two slides, a retained theme, logo, footer and speaker
notes. The task changes text and a title's font size, then appends a slide from
the existing design. Saved criteria inspect ordered slide relationships, text,
font size and preserved shape geometry, original notes, theme and image bytes.
In-app notes editing is not exposed. This task preserves notes; the separate
Microsoft add-in profile must test editing them.

`evaluateOfficeExecution` handles `capability.office`; the dispatcher supplies
the selected owned-session summary, actual workspace/task path,
`context.toolExecutions` from the verified complete tool journal, and exact
`context.ownedSessionIDs`. A returned tool call alone is insufficient: the
underlying Office response must report outer `ok:true` and a truthful domain
`result.ok:true` or `result.success:true`. An explicit false/error at either
level rejects the result. The raw return is retained; evidence records which
service flag was present rather than adding a manufactured success field.
Writes require a successful save, final reads require actual returned values and
timing after edits, and presentation previews must follow the relevant edits.
Native Code Mode metadata without actual child results fails this criterion.
The observer does not change tools or their results.

`evaluateSavedOfficeArtifact` handles `artifact.office_xlsx` and
`artifact.office_pptx` separately. It verifies the original controller file hash
before comparing the complete saved output. Live tool success, saved artifacts
and the visible open document are independent criteria.

The prepared suite explicitly leaves physical close/reopen observation pending
until the harness adds an ordinary post-task UI close/open flow. Its existing
`beforePrompt` action opens the real editor, and final live reads inspect the
working draft; neither proves a subsequent reopening. Unit criteria tests
exercise positive and deliberately corrupted saved files, not actual editor
calculation or a real-model run. Those application gates remain required in both
arms before claiming capability parity.


H86 corrects the earlier success-only wire assumption after the first real V1
Excel trial returned `result.ok:true` with both sheets. That trial was
interrupted separately when full-frame grayscale OCR missed its visible red
Deny button; its original literal failures and unchanged workbook remain
preserved. H86 combines whole-image grayscale and red-text OCR without crops,
keeps the same confidence/unique-target and exact pending-request checks, and
requires the native rejection event after the real X11 click. Two recognition
passes add measured permission-wait overhead; no task deadline or model/tool
output cap is added. A fresh exact admission is required before retesting.
