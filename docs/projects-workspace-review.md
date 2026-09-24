# Project workspace: first review

Branch: `codex/projects-akte-workspace`, based on `origin/dev` at `97eb4e9`.
Linear: EIG-206 and EIG-207 in [the sprint project](https://linear.app/eigenweltlabs/project/projects-tabular-review-and-jev-sprint-1-213c308658fb).

## Review the product

1. Open a project from the sidebar. The home follows Chris's Attio reference: identity and editable fields on the left, Overview / Files / Emails / Tasks / Notes / Activity across the main area. Emails remains disabled for the next sprint. Agents opens the project's sessions; Tabular Review is reserved for M2.
2. Create a named project using either storage option. The initial default is `~/LegalWork/Projects/<project name>`; `LEGALWORK_PROJECTS_DIR` can change the default root. A selected folder is used directly. Confirm this default location in product review. Same-named default projects receive separate folders. Existing documents remain in place.
3. Edit text, numeric, date and selection fields. Create/link a task from home; change its project in global Tasks; unlink it without deleting the task. Reload and confirm metadata and task links persist.
4. Create a note, find it in Notes and open it in the document viewer. Notes are Markdown files under the project's `Notes/` folder. Files opens the existing right sidebar. Navigation visibility persists across reloads.

## Delivery boundaries

- Reuses existing workspace identities, folder registry, sessions, file APIs and task storage.
- Project metadata is a versioned `.legalwork/project.json` sidecar with atomic writes and revision conflict detection. Documents are never moved into the metadata store.
- Task project links are local SQLite associations. EIG-208 must synchronize project identity, metadata, documents and these links; the existing task cloud protocol is unchanged.
- Activity lists recent updates from loaded tasks, root files, notes and sessions. It is a summary, not a complete audit history. Counts reflect loaded data; document counts cover files directly in the project root.
- Native desktop folder-dialog behavior and remote-worker compatibility still need release review. Browser checks use a real isolated LegalWork server and temporary files; the session engine is a stub. No model inference, JEV, OCR or cloud sync was exercised.
- Johann owns JEV/provider and OCR work. Full search, sync, Tabular Review and email remain in their planned tickets.

## Validation

- `pnpm --filter legalwork-server exec bun test src/project-store.test.ts src/task-store.test.ts src/tasks-api.test.ts src/workspace-activate.e2e.test.ts src/task-sync.test.ts`: 70 passed.
- `pnpm --filter @legalwork/app test`: 631 passed.
- App and server type checks passed.
- `pnpm --filter @legalwork/app test:i18n`: English and German complete.
- `pnpm --filter @legalwork/app build`: passed, with dependency annotation and bundle-size warnings.
- Browser review covers default and selected-folder creation, retaining an existing document, metadata saving, note creation and persistence, the tab layout, task reassignment/unlink/relink, persistent navigation preferences and the Files right sidebar.

Screenshots are local review artifacts under `output/playwright/`, excluded from source control.
