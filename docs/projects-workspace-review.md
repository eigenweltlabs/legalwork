# Project workspace review

[EIG-206](https://linear.app/eigenweltlabs/issue/EIG-206) and [EIG-207](https://linear.app/eigenweltlabs/issue/EIG-207) deliver the local Projects foundation and workspace. Branch: `codex/projects-akte-workspace`, targeting `dev`. This guide describes the final implementation; earlier ticket updates record superseded design iterations.

## Product behavior

Home is one centered page with inline project-name editing, a favorite star and labelled New Chat, Add note, New task and Record actions. There is no top tab bar, left overview column, Activity page or Sessions page. Optional project details expand below the header without a filled background.

Notes occupy one horizontally scrollable row of compact cards with content previews. Older cards load their previews as they enter view. Clicking any card opens the existing Markdown editor in the right viewer; saving updates its preview. Home, editor, tabs and Project Files show the note title without the unique storage suffix. Markdown remains in the project's `Notes/` folder, with its original path used for reading and saving.

Home embeds the shared Tasks list, six tasks per page, including server pagination beyond 50 tasks. It retains task context menus and the existing detail viewer without leaving Home. View all and the sidebar open a separate project Tasks page. Creating a task adds it to the list without opening it. Tasks can be linked, reassigned and unlinked; starting a linked task's session uses its project directly, and starting a workflow asks only for the workflow.

Record starts capture on Home and associates it with that project. While capture is active the action reads Stop recording, and New Chat uses a red dot as its icon. New Chat enables live recording context by default; its adjacent dropdown offers a chat without that context while capture continues. Synthetic transcript setup does not produce an Empty message row. Missing recording setup offers an explicit route to Recorder. The global Recorder action remains immediate and does not require a project. Below Tasks, Recordings supports linking existing recordings, playback and transcript viewing through existing components. Unlinking never deletes audio, and recordings may belong to multiple projects.

## Navigation and files

The main sidebar keeps app features above Projects. Each expanded project's inset contains Home, Tabular Review, Tasks, Files and Sessions. Tabular Review is reserved for milestone 2. Sessions expands a nested list with groups, Show more, drag ordering and existing right-click actions. Group children have a small additional indent. Project name and chevron both toggle expansion; Home and Tasks handle navigation. Opening a chat expands its session list. New projects appear first, preserving the order of older projects. Files opens a right panel without taking the active highlight from the main page.

The hover/focus cog replaces only the main feature section with an inline customization card. Projects and the lower sidebar stay visible. Current enabled items have filled blue checks; visibility and order persist. Drag handles also accept keyboard up/down. Done or Escape closes customization. Logo upload/reset and name editing occupy their existing header positions. Optional metadata defaults remain in Settings → Customization → Projects.

The right-hand local browser is named Project Files in English and Projektdateien in German, including its rail button on Home. It always has a close control. Its root breadcrumb follows the project display name; creating notes refreshes a mounted file list. Local file rows carry a same-project file reference into the composer using the existing attachment pipeline. References retain their original paths, including spaces and non-ASCII characters.

Home's native drop zone and Choose files move regular files into the registered project root. Collisions receive numbered names; existing files are never overwritten. Same-volume moves use exclusive links, and cross-volume moves copy successfully before removing the source. Partial failures are reported per file. The desktop handler resolves only registered local destinations, including projects created through the server after desktop startup; the renderer cannot supply a destination path.

## Storage and metadata

Create Project has a name and an optional source folder. Leaving the folder empty automatically creates a native default folder. Selecting a folder uses it directly and preserves its documents. The UI shows folder names rather than internal application paths.

Desktop defaults use the OS-resolved Documents folder: `LegalWork/Projects/<name>` in production and `LegalWork Dev/Projects/<name>` in development. Electron resolves Documents before the embedded engine's HOME override. Windows redirected, OneDrive and UNC Documents paths are covered by path-policy tests. `LEGALWORK_PROJECTS_DIR` can override the root with an absolute path. Headless servers retain their home-based default. Existing registered paths remain authoritative; this change does not relocate existing documents.

Projects retain stable IDs, folder registrations, session associations and local task links. Metadata is stored in versioned `.legalwork/project.json` with atomic writes and revision checks. Optional fields support text, number, date and selection. Untouched projects inherit blank defaults; saved schemas and deliberately cleared schemas are preserved. Save to defaults copies a custom field's definition and choices, never its matter-specific value. See [the researched default schema](project-metadata-schema.md).

Field type changes convert compatible values and reject conversions that would discard data. Removing an in-use selection option is rejected. Latest option edits are included when submitting with Enter. A concurrent write shows a conflict and Load latest fields rather than repeatedly submitting a stale revision.

Disconnected project folders stay registered and are not recreated by bootstrap, activation or background engine/MCP startup. Home and Files explain that the user must reconnect the drive or restore the original folder, with retry actions. Restoring it retains the same project ID, files and metadata. Selecting a different replacement root is not part of this delivery.

## Verification

Current UI checks use the actual macOS Electron development app through native controls. No browser substitute is used for final UI verification. Temporary QA projects and documents were used; no model prompt or workflow was submitted.

Verified in Electron:

- Native default-folder and selected-folder creation, preserving an existing document; new project ordering; inline rename across Home/sidebar/Files; route persistence after reload.
- Native Choose files moves a fixture into a server-created project's real folder; the source is removed and the destination bytes are unchanged.
- Missing-folder startup and Home error, followed by restoring the original folder and retrying successfully.
- Optional metadata, incompatible type conversion protection, Enter-to-save selection options and concurrent-edit recovery.
- Note creation while Files is open, clean titles, editor opening/closing/reopening, saved content previews and horizontal access to older notes.
- Home tasks through all 55 fixture rows across the server cursor boundary, list-only creation, context actions, shared detail viewer and workflow selection retaining its project.
- Recording on Home without navigation, Stop recording, red-dot New Chat, default live context and dropdown opt-out; capture finalized and linked. Empty transcript setup is not rendered as an empty user message.
- Session right-click actions, group creation and moving a session into a group through the native context menu.
- English and German layouts, native folder chooser, inline customization with correct checks and existing brand positions. Original language and navigation preferences were restored.

Native drag automation could start a drag but did not complete the operating-system drop gesture. File-reference logic and existing session drag/context-menu wiring were inspected, and reference encoding is covered automatically; a physical mouse pass for Files → chat and session regrouping remains a reviewer check. A real Windows desktop run also remains a release check. These are explicit verification limits, not claims of native end-to-end success.

Automated checks (run again after integrating the latest `dev`):

```sh
node scripts/i18n-audit.mjs --ci
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app test
pnpm --filter @legalwork/app test:i18n
pnpm --filter @legalwork/app build
pnpm --filter legalwork-server typecheck
pnpm --filter legalwork-server test
pnpm --filter legalwork-server build
pnpm --filter @legalwork/desktop typecheck:electron
pnpm --filter @legalwork/desktop test
pnpm --filter @legalwork/desktop check:electron
```

Regression coverage includes selected/default folder persistence, missing-folder recovery, metadata revisions and malformed metadata preservation, task associations, recording links/finalization, file collisions and cross-volume failure safety, trusted project lookup and encoded file references. Final local results: 643 app tests passed; 910 server tests passed with 11 optional-service skips; 180 desktop tests passed with 1 platform skip. The repository i18n audit, all type checks, both builds, 110-method IPC coverage and 4,254 English/German translation keys passed. The initial server run timed out during existing OAuth test setup; that test passed in isolation and the entire suite passed on rerun. CI results are recorded in the PR. Existing dependency-annotation and large-bundle build warnings remain. On this Mac the native build uses `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk`; no system SDK setting was changed.

## Delivery boundaries

Eigenwelt Sync (EIG-208), JEV/provider setup (EIG-209), Tabular Review/OCR (EIG-210), unified search and metadata filters (EIG-211), and full email remain separate deliveries. Task/project and recording/project links are currently local; synchronization must explicitly include them. Sessions must not sync unless individually shared. The final integrated sprint UX/UI pass remains EIG-214. Release is planned after milestone 2; email follows in its own sprint.
