# Project workspace: first review

Branch: `codex/projects-akte-workspace`, based on `origin/dev` at `97eb4e9`.
Linear: EIG-206 and EIG-207 in [the sprint project](https://linear.app/eigenweltlabs/project/projects-tabular-review-and-jev-sprint-1-213c308658fb).

## Review the product

1. Open a project from the sidebar. Identity and editable fields stay on the left; Overview / Files / Tasks / Notes / Activity are across the main area. Emails is absent. Overview contains brief counts, the next due task and the most recent session, rather than repeating the contents of every tab. The left sidebar nests Home / Tabular Review / Tasks / Files under each project, then a light divider and the five most recent sessions. Sessions have no added project topbar. Tabular Review is reserved for M2.
2. Create a named project using either storage option. Desktop defaults use the OS-resolved Documents folder: `LegalWork/Projects/<project name>`. Development builds use `LegalWork Dev/Projects` separately. Electron resolves the native Documents location before any engine HOME override, including Windows redirected/OneDrive/UNC locations. `LEGALWORK_PROJECTS_DIR` can override the root with an absolute path; headless servers retain their home-based default. A selected folder is used directly. Same-named default projects receive separate folders. Existing documents remain in place.
3. Edit text, numeric, date and selection fields. The Tasks tab renders the existing TasksPane and TaskList filtered by project, retaining their filters, actions and creation dialog. Opening a task uses the existing TaskPanel/TaskDetail in the right viewer without navigating away. Create/link a task; change its project or unlink it through the same detail view. Reload and confirm metadata and task links persist.
4. Create a note by naming it, then write in the existing ArtifactMarkdownPanel/ArtifactMarkdownEditor with its normal toolbar, Save action and unsaved-change handling. Notes are Markdown files under the project's `Notes/` folder. Files uses the existing file browser, and its project sidebar link opens the right sidebar. A small cog beside the sidebar brand opens Settings → Customization for navigation visibility, which persists across reloads. Projects has a visible + opening the creation modal. Raw paths are absent from the home and default-folder option; the native selected-folder control shows only its name.
5. Switch between project home and a session. The shell now has the same route wrapper, preserving the sidebar DOM, expansion and scroll state rather than remounting it on navigation.
6. Open a task or note in a narrower window. Outside Overview, the metadata column yields space to the active list and side-panel viewer when the main pane becomes narrow.

## Delivery boundaries

- Reuses existing workspace identities, folder registry, sessions, file APIs and task storage.
- Project metadata is a versioned `.legalwork/project.json` sidecar with atomic writes and revision conflict detection. Documents are never moved into the metadata store.
- Task project links are local SQLite associations. EIG-208 must synchronize project identity, metadata, documents and these links; the existing task cloud protocol is unchanged.
- Activity lists recent updates from loaded tasks, root files, notes and sessions. It is a summary, not a complete audit history. Overview counts reflect loaded tasks, notes and sessions; paginated task counts carry a plus marker.
- Remote-worker compatibility and a real Windows desktop run still need release review. The macOS Electron development app was launched for interactive testing. Browser checks use a real isolated LegalWork server and temporary files; the session engine is a stub. No model inference, JEV, OCR or cloud sync was exercised.
- Johann owns JEV/provider and OCR work. Full search, sync, Tabular Review and email remain in their planned tickets.

## Validation

- `pnpm --filter legalwork-server exec bun test src/project-store.test.ts src/task-store.test.ts src/tasks-api.test.ts src/workspace-activate.e2e.test.ts src/task-sync.test.ts`: 70 passed.
- `pnpm --filter @legalwork/app test`: 632 passed.
- App and server type checks passed.
- `pnpm --filter @legalwork/app test:i18n`: English and German complete.
- `pnpm --filter @legalwork/app build`: passed, with dependency annotation and bundle-size warnings.
- Browser review covers default and selected-folder creation, retaining an existing document, metadata saving, note creation and persistence, the tab layout, task reassignment/unlink/relink, persistent navigation preferences and the Files right sidebar.

Screenshots are local review artifacts under `output/playwright/`, excluded from source control.


## Sidebar and storage refinement validation

- App tests: 632 passed; app type check and 4073 translation keys in both languages passed.
- Desktop runtime tests: 25 passed, including macOS Documents, Windows redirected/UNC Documents and development isolation. Electron type check passed.
- Project folder tests cover Windows reserved names, invalid characters, collision handling and preservation of existing documents.
- The native host supplies the new-project root; existing registered project paths remain authoritative, with no automatic file moves.
- Targeted project storage and workspace API tests: 17 passed. Desktop runtime tests verify the Windows path policy; an actual Windows desktop run remains outstanding.
- Browser checks confirmed that the Tasks tab contains only its project's task, clicking the row opens the existing task viewer while retaining the project URL, and the Markdown editor saves notes to disk. The navigation cog opens Customization; the project modal has no raw application path; Emails is absent. The same sidebar DOM node survives project-to-session navigation and back.
- On this Mac, the default native-module build picked an incompatible command-line SDK. The development launch uses `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk`; no system SDK setting was changed.
