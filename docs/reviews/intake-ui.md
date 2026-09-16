# Intake UI review — 15 September 2026

This pass covers the Tasks feature in the existing intake worktree. The real React components were reviewed in the isolated development fixture. All examples use synthetic data.


## Revised after visual feedback

- Replaced priority dots with status shapes: open, in progress, done and cancelled. Removed row timestamps and the selected-card outline; the status tabs use the app’s shared pill component.
- Removed the priority/date header line and local-run timestamp paragraph. The title, editable status/assignee, and run actions remain primary.
- Attachments, triage note, original message and details now share one disclosure component, including icons and equal vertical padding.
- Browser measurements: all four collapsed rows are 52 px high, with identical left edges and widths at desktop and 390 px. Header actions share the content's horizontal padding.
- [Revised task detail](intake-ui/legal-refined-detail.png) · [Revised mobile detail](intake-ui/legal-refined-mobile.png).

Earlier screenshots below document the previous pass. The revised screenshots above show the current task layout. The final typecheck, translation check, 17 task tests and UI build passed again.

## Screen coverage

| Surface | Reviewed states |
| --- | --- |
| Task queue | Grouped statuses, filters, selection, long titles, empty queue, request error with retry, plan gate |
| Task detail | Long German title, duplicate assignee names, status and assignee controls, attachments, expandable triage note, original message and metadata |
| Run controls | First run, existing local run, rerun menu, cloud-running task |
| Start workflow | Folder/workflow selection, loading, empty library, failed library with retry, disabled start |
| Start session | Task context, folder selection, no folders, disabled start |
| Responsive layout | Desktop split pane and narrow stacked navigation; 320/390/1024/1440 px reviewed across the pass; final dialogs also checked at 390 × 650 |

## Visual evidence

- [Task detail with long German text](intake-ui/legal-long-detail.png)
- [Workflow picker](intake-ui/legal-workflow.png)
- [Workflow load error in a short window](intake-ui/legal-workflow-error.png)
- [Empty workflow library](intake-ui/legal-no-workflows.png)
- [Session without folders](intake-ui/legal-no-folders.png)
- [Empty queue](intake-ui/legal-empty.png)
- [Queue request error](intake-ui/legal-queue-error.png)
- [Plan gate](intake-ui/legal-plan-gate.png)

## Reproduce

Run `pnpm --dir apps/app exec vite --host 127.0.0.1 --port 5191` and open `/tasks-preview.html`.

Fixture flags can be combined: `lang=de`, `long`, `local-run`, `empty`, `error`, `locked`, `no-folders`, `no-workflows`, `workflow-error`. The fixture is excluded from production builds.

## Validation

- `pnpm typecheck` — passed.
- `pnpm --dir apps/app test:i18n` — passed, 3,773 keys in both shipped languages.
- `pnpm --dir apps/app exec bun test tests/intake-task-format.test.ts tests/intake-task-reference.test.ts tests/intake-task-submission.test.ts` — 17 passed.
- `pnpm build:ui` — passed; existing dependency and bundle-size warnings remain.
- `git diff --check` — passed.

This validates UI layout and fixture interactions. Live email ingestion, native Electron file opening, and actual local/cloud execution were not exercised by this visual review.
