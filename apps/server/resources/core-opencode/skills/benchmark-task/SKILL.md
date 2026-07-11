---
name: benchmark-task
description: >-
  Create a task for the LegalWork model benchmark from a description. Use when the user
  wants to "create/add a benchmark task", "make a new eval or test case", "turn this into a
  benchmark task", or "add this to the benchmark" — i.e. define a legal task with
  instructions and pass/fail criteria to compare how connected models perform.
---

# Create a benchmark task

The LegalWork **benchmark** compares how connected AI models perform on realistic legal
tasks. Each task has instructions, expected deliverables, and a rubric of independently
judged **pass/fail criteria**. This skill turns a user's description (or an open matter)
into a well-formed task and saves it to the benchmark's **Tasks** table with the
`benchmark_create_task` tool.

## What a good task looks like (the Harvey Legal Agent Benchmark shape)

- **title** — a short, specific name, e.g. "Review PO1 against the 2021 ICC Rules".
- **workType** — one of `analyze`, `draft`, `review`, `research`.
- **tags** — practice-area / vertical tags; the first tag is treated as the vertical
  (e.g. `["Arbitration", "ICC Rules"]`).
- **instructions** — directional instructions to the model, in the second person, that
  name the expected output file(s). Example: "Review the attached procedural order against
  the 2021 ICC Rules and produce `compliance-report.docx` listing each deviation …".
- **documents** (`documentPaths`) — INPUT files the model must read, passed as file paths
  (workspace-relative or absolute), e.g. `["documents/procedural-order.docx"]`. These are
  attached to the task and staged for every run. Do not confuse them with deliverables
  (the model's OUTPUT). If the user refers to files in the workspace/matter, pass their
  paths here; you may also write a file first (e.g. save pasted text) and then pass it.
- **deliverables** — the output filenames the model must produce, e.g.
  `["compliance-report.docx"]`. Optional but recommended; criteria reference them.
- **criteria** — the rubric. Each criterion is judged **independently**, so make every one
  atomic and objectively verifiable. Write each `matchCriteria` as an explicit rule:
  **"PASS if <specific, checkable condition>. FAIL if <condition> is not met."** Anchor it
  to concrete facts (article numbers, dates, names, amounts) wherever you can.

## How to do it

1. **Gather the task.** If the user pointed you at a document or matter, base the task on
   it and attach the relevant source files via `documentPaths`. Ask only for what's
   genuinely missing; infer sensible values otherwise.
2. **Draft the fields above.** Aim for **5–15 sharp criteria** unless the user asks for
   more — each testing one distinct, checkable thing. Don't invent criteria that can't be
   judged objectively from the deliverable.
3. **Call `benchmark_create_task`** with the fields, including `documentPaths` for any
   input files the model needs to read.
4. **Confirm** what was created (title, number of criteria, and any documents attached) and
   tell the user it's now in the benchmark's **Tasks** tab, where they can edit it, add or
   remove documents, or include it in a run.

## Notes

- `documentPaths` are read from disk at creation time and copied into the task, so the
  paths must exist and be readable when you call the tool.
- Criterion ids are optional — they're auto-assigned (C-001, C-002, …) when omitted.
