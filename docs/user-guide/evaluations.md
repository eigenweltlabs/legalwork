# Evaluations

Open in LegalWork: [Evaluations](legalwork://app/evals).

Open **Evaluations** from the main sidebar. It contains benchmark **Tasks**, **Eval runs** and **Your Leaderboard**. These benchmark tasks are separate from the firm's Tasks work list.

## Prepare a benchmark

Import supported tasks from the Legal Agent Benchmark catalog, import a ZIP in the supported task format, or create a custom task. A custom task has a title, instructions, input documents, deliverable filenames and pass/fail criteria. At least one non-empty criterion is required. Deliverable filenames must be filenames, not paths with slashes. Tags let you group results by practice area or work type.

Write criteria that can be checked against the output, such as whether a specified clause is identified and cited. A vague request for a "good memo" makes the judge's score difficult to interpret. Review imported tasks and documents before running them. Export selected tasks as a ZIP to reuse the benchmark.

## Run a comparison

1. Select the tasks to evaluate and create a **New eval**.
2. Pick the connected models to test and a judge model.
3. If needed, configure comparison arms. These can restrict skills/workflows or tools to test their contribution; a baseline arm keeps the normal available capabilities.
4. Review the number of evaluations and start. More tasks, models and arms produce more work and model usage.
5. Follow progress in **Eval runs**. Inspect a failure before retrying or resuming. Use **Abort run** to stop a run when required; interrupted runs can expose a resume action.

The worker performs the evaluations with the configured models. Keep its runtime available while work is active. The judge grades deliverables against each task's criteria; it is still a model, so a score should be inspected rather than treated as legal validation.

## Inspect the evidence

Open a run to compare models, task results and individual criterion verdicts. Review deliverables, the judge's rationale and the recorded agent session when present. The benchmark transcript is read-only. Filter results and view tag breakdowns or the leaderboard to understand where models differ. The displayed score is the mean rubric pass rate, not a general guarantee of correctness on all legal work.

Deleting benchmark tasks can permanently remove their results. Read the confirmation and export anything you need first. This differs from the restorable trash in the ordinary Tasks list.

You can ask the assistant to create a benchmark task from an appropriate example using the bundled `benchmark-task` skill and its supported tool. Check the proposed task and criteria before running a model comparison.

Related: [Models and Fusion](models-fusion.md), [Files](files-documents.md), [Tasks](tasks-intake.md).
