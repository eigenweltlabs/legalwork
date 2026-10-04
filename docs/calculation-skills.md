# Inspectable calculations and expert corrections

The existing skill system remains the entry point. Workflows is its user-facing home. Both workflows and supporting skills are automatically discoverable; their library classification does not restrict loading, composition or calculation code.

## Shipped calculators

Load a jurisdiction skill with `legalwork_skill_load`. This resolves its base and applicable extensions, checks their pinned package hashes, and returns their instructions. Run `legalwork_deadline_calculate` for supported executable rules. Call `legalwork_calculation_present` with the returned receipt IDs to opt into a card. Presentations do not accept replacement dates or fabricated arithmetic steps. The server reads the recorded inputs, code-generated trace, cutoff and code hash.

For shipped jurisdiction skills, the load response also returns the current calculation tool contract and interaction guidance, including the input schema generated from the actual calculator schema. This applies to older installed packages and their composed corrections without rewriting their files or invalidating pins. The agent calls the tools directly; it must not inspect bundled executables or search application folders to discover their arguments. The shipped skills present cards without the user naming a widget or tool. Community skills retain control over whether to present a card.

`selection` is an explicitly labelled agent assessment of the requested legal deadline. It is not presented as a proven consequence of the calculator. A refusal or missing-facts conclusion uses an assessment with no dates. A presentation can contain multiple independent receipts, without reducing them to one deadline.

`show` is the default: show a supported calculation directly when its material facts are established. Read the available evidence first and do not ask the user to reconfirm it or answer hypothetical exceptions. A request to calculate does not authorize a calendar write. A request to add a deadline does: save the exact receipt and show its calculation without an extra approval step. This does not mark the entry human-verified.

When a fact could change the requested result and is absent from the record, show an assessment without a date and ask a focused question. Do not substitute an ordinary response date for an unknown statutory cutoff. An unsupported executable rule needs a clear limitation, not an irrelevant questionnaire.

For an existing deadline, read its current revision and use `legalwork_calendar_update`. Recalculations pass the new `calculationId` and exact `start`/`timeZone`, preserving the entry ID, project, existing links and earlier receipts in its history. Manual overrides require a reason. A pending or rejected confirmation also blocks attaching its receipt through an update. Calendar tools resolve the chat's project and refuse unknown directories instead of falling back to another project. File discovery uses the silent file tool; the visible project contents card is reserved for requested overviews.

Use `confirm` for an explicit request to review before saving or an applicable substantive review requirement. Its Save button creates the exact reviewed deadlines in one transaction. Duplicate clicks return the same items. A pending/rejected card prevents agent background saves using its receipts, including through a later show card. Rejected cards cannot later be approved. The sources must still have the same hashes when saved. New facts require a new run and card. Current interaction guidance supersedes generic confirmation advice in older bundled skills without rewriting installed skill packages or breaking pinned corrections.

## Custom Python skill code

A standard installed skill can attach a single file named `resources/calculation.py`. Use `legalwork_skill_create(resourcePaths=[...])` with a source file named `calculation.py` to install it through the normal skill library. It must implement:

```python
from datetime import date, timedelta

def add_weeks(trigger, weeks):
    return (date.fromisoformat(trigger) + timedelta(weeks=weeks)).isoformat()

def calculate(inputs, recorder):
    day = recorder.step(
        "Nominal end", "Two calendar weeks from the established trigger",
        add_weeks, inputs["trigger"], inputs["weeks"],
    )
    # This illustrative fragment is not a complete legal deadline calculator.
    # Add instrumented branch, holiday, suspension, extension and cutoff checks.
    return {"status": "needs_information", "missingFacts": [
        "Applicable legal rule, endpoint adjustment and cutoff must be established."
    ]}
```

`legalwork_calculation_run(skill, input)` executes a snapshot of this installed script under the server's execution approval policy. The child receives JSON via stdin and runs isolated Python with the standard library. Use `LEGALWORK_CALCULATION_PYTHON` to configure the Python binary when it is not on PATH. Python is required for community scripts; shipped calculators do not need it.

The recorder captures each called function's bound inputs, actual return value, source and line number. `reason` and `title` are authored by the skill. They are explanatory labels, not independent proof of legal correctness. Instrument every meaningful decision, including branches that stop calculation. Uninstrumented arbitrary scripts do not gain a trustworthy step-by-step explanation automatically. The complete executed script and its hash remain in the stored audit record. The chat card shows readable dates, concise recorded steps and the result; it does not render dependency bundles, hashes or raw intermediate arguments.

Return `status: calculated` with `results: [{title, date, cutoff, timeZone}]`, or `needs_information` / `requires_specialist_review` with `missingFacts` and no dates. `date` is the local calendar day. `cutoff` is an ISO instant with timezone offset, and `timeZone` is an IANA zone. End-of-day deadlines use the exclusive next-day midnight instant. Do not assume every deadline ends at midnight. Multiple results are supported. Call `legalwork_calculation_present(runId)` to show them.

Installed scripts are executable code, not a security sandbox or legally certified calculators. Execution has a 15-second limit and bounded output. This initial contract supports a single standard-library Python file, not arbitrary third-party packages or a general Python debugger.

## Teaching through existing skills

With the lawyer's instruction to remember a correction, call `legalwork_skill_create` with `kind: workflow`, a new name, `scope: project | global`, and:

```json
{
  "lesson": {
    "base": "de-civil-deadlines",
    "appliesWhen": "Precisely scoped legal situation",
    "correction": "The approved correction and the facts needed to apply it",
    "examples": [
      {"input": "Previously failing case", "expected": "Correct outcome"},
      {"input": "Nearby unaffected case", "expected": "Existing correct outcome"}
    ]
  }
}
```

The extension is a normal `SKILL.md` plus `legalwork-extension.json`. Saved corrections are classified as workflows, including existing extensions without a workflow name prefix. Classification does not rename files or change pinned hashes. New corrections receive the standard workflow name prefix even if an older caller requests `kind: skill`. The base instructions/code are not overwritten. Global means this user's local library, shown in Workflows, not automatic firm-wide distribution. Project scope stays in the project. The engine receives normal skill frontmatter; composition metadata is stored separately. Loading the base automatically includes applicable corrections, without a manual workflow run.

Dependencies resolve base-first with cycle and missing-base checks. A changed base package blocks loading until the extension is reviewed/rebased. Multiple scoped corrections are returned together; semantic conflicts must be raised with the lawyer, not resolved silently by file order. Examples are saved expectations, not automatically executed tests. For a code defect, fix the code and run executable regression tests separately. Prose corrections cannot expand a calculator's implemented coverage.

## Evidence

`path`, one-based `page`, and exact `quote` are resolved against the current source. The server binds the source hash, verifies text/OCR evidence and derives highlight boxes. It automatically prepares a scanned PDF with the configured document preparation service when native text is insufficient. Each document appears once, with all its quoted passages accessible through that one button. TXT/Markdown sources use an exact unique quote and no page number. Duplicate passages require a longer unique quote. Missing or stale matches fail instead of highlighting an arbitrary location. Clicking the chip opens the existing native document evidence viewer.

## Validation boundaries

Regression tests cover receipt binding, independent month clocks, idempotent atomic saves, rejected/stale review, cross-project access, modified PDFs, literal/ambiguous source matches, actual Python function traces, missing-information outputs, scoped composition and base-version changes. This validates the mechanism; it does not establish that every DeadlineBench jurisdiction/rule is implemented, or that every model will apply a natural-language correction correctly.
