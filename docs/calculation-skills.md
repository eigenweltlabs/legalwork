# Inspectable calculations and expert corrections

The existing skill system remains the entry point. There is no new workflow type.

## Shipped calculators

Load a jurisdiction skill with `legalwork_skill_load`. This resolves its base and applicable extensions, checks their pinned package hashes, and returns their instructions. Run `legalwork_deadline_calculate` for supported executable rules. Call `legalwork_calculation_present` with the returned receipt IDs to opt into a card. Presentations do not accept replacement dates or fabricated arithmetic steps. The server reads the recorded inputs, code-generated trace, cutoff and code hash.

`selection` is an explicitly labelled agent assessment of the requested legal deadline. It is not presented as a proven consequence of the calculator. A refusal or missing-facts conclusion uses an assessment with no dates. A presentation can contain multiple independent receipts, without reducing them to one deadline.

In `show` mode the card is informational. In `confirm` mode its Save button creates the exact reviewed deadlines in one transaction. Duplicate clicks return the same items. A pending/rejected card prevents agent background saves using its receipts. Rejected cards cannot later be approved. The sources must still have the same hashes when saved. New facts require a new run and card.

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

The recorder captures each called function's bound inputs, actual return value, source and line number. `reason` and `title` are authored by the skill. They are explanatory labels, not independent proof of legal correctness. Instrument every meaningful decision, including branches that stop calculation. Uninstrumented arbitrary scripts do not gain a trustworthy step-by-step explanation automatically. The complete executed script remains inspectable and its hash is retained.

Return `status: calculated` with `results: [{title, date, cutoff, timeZone}]`, or `needs_information` / `requires_specialist_review` with `missingFacts` and no dates. `date` is the local calendar day. `cutoff` is an ISO instant with timezone offset, and `timeZone` is an IANA zone. End-of-day deadlines use the exclusive next-day midnight instant. Do not assume every deadline ends at midnight. Multiple results are supported. Call `legalwork_calculation_present(runId)` to show them.

Installed scripts are executable code, not a security sandbox or legally certified calculators. Execution has a 15-second limit and bounded output. This initial contract supports a single standard-library Python file, not arbitrary third-party packages or a general Python debugger.

## Teaching through existing skills

With the lawyer's instruction to remember a correction, call `legalwork_skill_create` with `kind: skill`, a new name, `scope: project | global`, and:

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

The extension is a normal `SKILL.md` plus `legalwork-extension.json`. The base instructions/code are not overwritten. Global means this user's local skill library, not automatic firm-wide distribution. Project scope stays in the project. The engine receives normal skill frontmatter; composition metadata is stored separately.

Dependencies resolve base-first with cycle and missing-base checks. A changed base package blocks loading until the extension is reviewed/rebased. Multiple scoped corrections are returned together; semantic conflicts must be raised with the lawyer, not resolved silently by file order. Examples are saved expectations, not automatically executed tests. For a code defect, fix the code and run executable regression tests separately. Prose corrections cannot expand a calculator's implemented coverage.

## Evidence

`path`, one-based `page`, and exact `quote` are resolved against the current source. The server binds the source hash, verifies text/OCR evidence and derives highlight boxes. Duplicate passages require a longer unique quote. Missing or stale matches fail instead of highlighting an arbitrary location. Clicking the chip opens the existing native document evidence viewer.

## Validation boundaries

Regression tests cover receipt binding, independent month clocks, idempotent atomic saves, rejected/stale review, cross-project access, modified PDFs, literal/ambiguous source matches, actual Python function traces, missing-information outputs, scoped composition and base-version changes. This validates the mechanism; it does not establish that every DeadlineBench jurisdiction/rule is implemented, or that every model will apply a natural-language correction correctly.
