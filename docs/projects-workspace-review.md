# Project workspace review

Branch: `codex/projects-akte-workspace`, based on `origin/dev` at `97eb4e9`.
Linear: EIG-206 and EIG-207 in [the sprint project](https://linear.app/eigenweltlabs/project/projects-tabular-review-and-jev-sprint-1-213c308658fb).

## Current layout

Home is a single centered page with the project name, pencil and favorite-star actions, a New Chat button and note/task creation buttons. It has no tab bar or left overview column. The name has no background badge. A compact Project details disclosure retains optional inline metadata and field configuration. Notes are the main list, followed by a link to the project's Tasks page with its open-task count.

Tasks has its own `/workspace/:workspaceId/tasks` route and uses the existing TasksPane and TaskList filtered by project. Opening a task uses the existing TaskPanel/TaskDetail in the right viewer while retaining this route. Creating a task only refreshes the list; it does not select the task or open a viewer tab.

The Sessions page has been removed. Sessions remain accessible from the project's sidebar expander, including groups, Show more, archives, drag-and-drop and right-click actions. The former Activity, Notes and Overview tabs are gone. Old `?tab=tasks` links redirect to Tasks; other old project-tab links resolve to Home.

## Review the product

1. Open Home from an expanded project. Review the title, spacing, quick actions and notes list with the right viewer both closed and open. Expand Project details to edit optional fields. Text, numeric, date and selection fields retain their existing inline editing and save behavior. The cog opens field configuration.
2. Create a note and write in the existing ArtifactMarkdownPanel/ArtifactMarkdownEditor with its toolbar, Save action and unsaved-change handling. Click anywhere on an existing note row, including its date, to read it. Notes are Markdown files under the project's `Notes/` folder. Tabs and editor headers show clean titles; the unique storage suffix is hidden without changing file paths or save targets.
3. Open Tasks from the project sidebar or Home. Check the standard filters and actions, project assignment, task detail viewer, and reload behavior. Create from either the Home task icon or Tasks list: the dialog closes and the task is added to the list. Linked tasks start sessions directly in their project; workflow start asks only for a workflow. An unavailable linked project produces an error rather than choosing a different project.
4. Expand Sessions in the sidebar. This only toggles its list; it does not navigate away from Home or Tasks. Open a session, use its right-click actions and groups, then return to Home. The shared route shell preserves the sidebar DOM and scroll state. No project topbar is added to chat sessions.
5. Open Files from the nested project menu or the right-side Workspace files icon. Both use the existing file browser. The active project feature follows the main view, not whether Files is open. The viewer always offers a close control.
6. Create a named project with or without adding a source folder. The modal has one optional Add action and no storage-mode dropdown. Leaving the source empty, cancelling the picker, or removing a selection uses the default location automatically. A selected folder is used directly, preserving its existing documents. The UI shows a selected folder's name, never the application's internal path.
7. Check English and German. Dates use the chosen app language; user-authored content and custom field definitions retain their values. Test narrower windows with the note or task viewer open.

## Sidebar and metadata

Clicking a project's name, folder icon or chevron toggles expansion without navigating away. Enter/Space also work. Expanded contents share one inset and a quiet vertical rule. Home / Tabular Review / Tasks / Files / Sessions sit together on a subtle background; Tabular Review remains reserved for milestone 2. Switching to Home or Tasks closes the expanded session list. Sessions is labelled “Sessions” in both languages. Small New Chat and Create Group actions appear on hover or keyboard focus.

Projects has a + opening the creation modal. The navigation cog appears only while hovering or focusing the sidebar and opens Settings → Customization. Navigation visibility preferences persist across reloads. Emails is absent.

Settings → Customization → Projects edits the optional default metadata fields. New projects and untouched older projects receive blank defaults. Previously configured schemas, values and deliberately cleared fields are preserved. Custom field rows offer Save to defaults, copying definitions and choices without copying values. See [the researched schema](project-metadata-schema.md).

## Storage and delivery boundaries

- Existing workspace identities, folder registry, sessions, file APIs and task storage are reused.
- Desktop defaults use the OS-resolved Documents folder: `LegalWork/Projects/<project name>`. Development uses `LegalWork Dev/Projects`. Electron resolves the native Documents location before any engine HOME override, including Windows redirected/OneDrive/UNC locations. `LEGALWORK_PROJECTS_DIR` can override the root with an absolute path; headless servers retain their home-based default. Same-named projects receive separate folders. Existing registered paths remain authoritative; documents are never automatically moved.
- Metadata uses a versioned `.legalwork/project.json` sidecar with atomic writes and revision conflict detection. Task project links are local SQLite associations. EIG-208 must synchronize project identity, metadata, documents and these links; the existing task cloud protocol is unchanged.
- The Home task count reflects loaded tasks; paginated counts carry a plus marker. Home has no activity timeline or session summary.
- Johann owns JEV/provider and OCR work. Full search, sync, Tabular Review and email remain in their planned tickets.

## Validation

The current Home redesign passes the app type check and production build, and all 638 app tests pass. Existing dependency annotation and bundle-size warnings remain. Browser checks use an isolated real LegalWork server with temporary files and a stub session engine; they do not modify the user's project data or exercise model inference.

Earlier storage and interaction checks covered default/selected-folder creation, preserving existing documents, notes saved to disk, metadata defaults and persistence, task project assignment, linked-session routing, sidebar drag-and-drop and context actions, and navigation preferences. Server project/task tests passed (70 tests); desktop runtime tests passed (25 tests), including Windows path handling. English and German translation completeness and app/server/Electron type checks passed during those changes.

The macOS Electron development app remains available for interactive review. A real Windows desktop run, remote-worker release review, JEV/OCR and cloud sync are still outstanding. On this Mac the native-module build needs `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk`; no system SDK setting was changed.

Screenshots are local review artifacts under `output/playwright/`, excluded from source control.
