# Dashboard flow review — 21 October 2026

Scope: generation → Save / Save a copy → saved locations → project and wiki navigation → both file explorers → ordinary file rename/copy/import. This includes existing file/storage behavior exposed by the dashboard feature, not just lines introduced in PR #322.

Only the requested **Open in the owning project/wiki** correction has been implemented. The findings below are recommendations, not implemented changes.

## 1. High: ordinary file copying does not preserve dashboard meaning

The explorer's **Copy to project** transfers raw bytes through `ProjectFileTransfer` (`apps/app/src/react-app/domains/workspace/project-file-transfer.tsx:68`) and `importProjectFile` (`apps/server/src/project-file-links.ts:51`). This bypasses the dashboard-aware `viewInputForDestination` conversion (`apps/app/src/react-app/domains/views/view-save.ts:19`).

A dashboard with dataset source paths and no explicit `sourceOwner` will consequently resolve those paths against its destination project. `ViewRepository.records` assigns the destination owner, while the renderer falls back to that owner for source links (`apps/app/src/react-app/domains/views/view-renderer.tsx:69`). The displayed values can still be from project A, but their links point to project B. Raw copying of live wiki files into another wiki similarly retains queries that will now execute against the destination wiki; copying those live files into a project cannot resolve the wiki queries.

Raw imports also retain the internal dashboard ID. Importing the same dashboard again under another filename in the same owner leaves two records with the same ID: the repository deliberately excludes both from its list and returns a revision-conflict error. Their bytes are preserved; this is an identity conflict, not deletion (`apps/server/src/views/repository.ts:45`).

**Proposed fix:** recognize dashboard files during copy/import and explicitly distinguish an independent copy from restoring/synchronizing an existing file. Independent copies need a new ID, preserved source attribution, and a snapshot for queries that cannot retain their original owner. External file sharing needs a small export/import contract for the same reason. Keep conflict detection for actual synchronization conflicts.

**Verification:** exercised the real `ViewRepository` with isolated in-memory files. A raw A → B copy resolved an unattributed dataset's source owner to B; a raw wiki copy retained live queries under wiki B; adding a second filename with the same ID returned zero listed views and a conflict. No user files were touched. The existing Save a copy path already handles new identity and cross-owner snapshots correctly.

## 2. Medium: Rename does not rename the title users see

The explorer displays `view.title` (`apps/app/src/react-app/domains/session/panel/workspace-files-panel.tsx:173`), but its generic Rename dialog edits `entry.name` and executes only a filesystem rename (`apps/app/src/react-app/domains/session/panel/workspace-entry-menu.tsx:49`, `:97`). Renaming `uuid.view.json` to `Quarterly overview.view.json` still leaves the original dashboard title in the explorer and tab. Removing the special extension also prevents dashboard recognition.

**Proposed fix:** a dashboard-aware Rename edits its title with the existing revision guard and preserves the file type. If the physical filename should also be human-readable, treat that as a deliberate coordinated change rather than presenting a raw UUID and editable extension as the dashboard's name.

**Verification:** moving the stored bytes to `Dashboards/Renamed.view.json` through the repository's file adapter returned the new path and the unchanged old title.

## 3. Design: the dashboard folder looks like a dashboard file

The shared explorer uses the exact same `DashboardIcon` at `size-5` (20 px) for the Dashboards folder and every dashboard file (`apps/app/src/react-app/domains/session/panel/workspace-files-panel.tsx:192`). The normal `FolderIcon` also has a 20 px box, so this is not a larger CSS size. The tile icon has a taller, squarer silhouette and a different visual treatment from the blue folder asset; it looks more prominent and communicates a document/app rather than a container. The folder chevron appears only on hover/focus.

**Proposed fix:** retain the existing folder silhouette for the container, with a small dashboard badge on its face. Use a separate, simpler dashboard/document glyph for files, optically sized around 16–18 px inside the same row slot. Apply it consistently in the main explorer, file sidebar, wiki tree, and tabs. This preserves recognition without introducing a second dashboard category.

## 4. UX clarification: distinguish frozen data from live data

The toolbar labels a live wiki view **Live dashboard**, but a frozen project/cross-owner view just **Dashboard**, and both show **Refresh** (`apps/app/src/react-app/domains/views/view-renderer.tsx:97`). For a frozen view, refresh reloads the saved file; it does not recompute its source data (`:43`). The timestamp exists under the expandable Data section, and copying live queries already shows a snapshot warning, so this is an ongoing-state clarity gap rather than missing snapshot protection.

**Proposed fix:** show **Snapshot · data as of …** for frozen datasets and label its refresh action **Reload saved file**. Keep **Refresh data** for a live query. Do not imply an automatic source update that the backend cannot perform.

## Fixed and checked in this change

- Already saved in → Open selects the saved file in its owner's workspace and navigates there.
- Wiki navigation resolves the wiki's workspace ID, including read-only wikis. Project navigation resolves the owning server and remote UI ID. Missing/unconnected targets leave the dialog open with an error instead of opening a tab in the current workspace.
- Existing source tabs remain intact; legacy target tabs migrate before the dashboard is selected.
- 52 targeted tests passed, with 220 assertions. Typecheck and the English/German translation check passed.
- Browser verification with synthetic data: Northstar Legal → Personal → Firm knowledge, correct owner header and dashboard tab at each destination. Other review recommendations above remain unimplemented.

Evidence: [Project destination](open-saved-project.png), [Wiki destination](open-saved-wiki.png).
