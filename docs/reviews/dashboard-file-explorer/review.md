# Dashboard flow review — resolved follow-ups, 21 October 2026

Scope: generation → Save / Save a copy → saved locations → owner navigation → both explorers → ordinary file rename/copy/import.

## Implemented

1. **Independent copies preserve dashboard meaning.** App copy/import paths recognize `.view.json`, assign a fresh ID, and preserve source owners and server provenance. A repeated import no longer produces duplicate IDs that hide both records. This covers cross-project copies, project-to-wiki imports, native file/folder imports, and wiki file/folder duplication. Cross-owner transfers freeze live queries against the source wiki. Same-wiki duplication keeps its live queries. Existing synchronization, restoration and revision-checked editing retain identity.
2. **Rename changes the visible title.** Project explorer, file sidebar and wiki menus use the dashboard update API with revision protection. The JSON filename and `.view.json` suffix remain intact. Explorer titles and open dashboard tabs refresh; search and pinned entries use the same title metadata. The generated content is preserved, including any heading inside its program.
3. **Snapshot and live behavior are explicit.** Frozen data shows `Snapshot · data as of …` (the oldest included dataset timestamp) and `Reload saved file`. Live queries show `Live dashboard` and `Refresh data`. `Export snapshot` produces a shareable `.view.json` with frozen data and source context. A legacy live file without its required snapshot is rejected on import with an export instruction, rather than executing its queries against the recipient's wiki.
4. **Folder and file icons are distinct.** The Dashboards container uses the existing folder silhouette with a small dashboard badge. Dashboard files use a 16 px icon in the normal row slot, consistently in the explorer, sidebar and wiki tree.

The preceding owner-navigation fix remains: Already saved in → Open switches to the saved file's project or wiki, preserving the source workspace and migrating legacy destination tabs first.

## Boundaries

- Import/copy means an explicit operation through LegalWork. Raw operating-system or sync copies keep their identities; actual sync conflicts remain visible and are not silently converted into independent copies.
- Exported snapshots retain source metadata. On another or unknown server, their data remains readable but source navigation is unavailable instead of opening an unrelated destination file. This does not grant source access or transfer credentials.
- The optional source metadata extends the strict view schema. Use the matching app/server version for these flows; older versions may reject newly exported files. There is no database migration or rewrite of existing files.
- Native imports use the server's authenticated, approval-checked import route. A failed dashboard import cannot fall back to an unsafe raw copy; folder import failures are surfaced.

## Validation

- App/OpenUI tests: **92 passed, 426 assertions** across 15 files (views, saving, copy receipts, navigation, chat deletion, generation, board actions, file sidebar/drop behavior, wiki import/tree, and OpenUI rendering).
- Existing project-file access tests: **4 passed, 19 assertions**.
- Server HTTP/repository/wiki tests: **65 passed, 413 assertions; 1 pre-existing failure**. The remaining `graph polling observes edits, assets, folders and configuration without returning rich snapshots` failure receives `unchanged` instead of `delta`. Reproduced the same failure using the unchanged store and test from prior commit `6884fdd2`; it is not introduced by this follow-up. The copy collision regression found during development was fixed and its existing test now passes.
- Native file/folder import tests: **14 passed**.
- App and Electron typechecks, app production build, server build/typecheck, translation check (**7,044 keys in English and German**), and `git diff --check`: passed. App build reports dependency annotation and chunk-size warnings.
- Browser check with synthetic data: rename updates the explorer and tab, the program still renders, snapshot data/timestamp survives reload, the reload action is accurately labeled, and the folder badge/file icon appear in the existing explorer and sidebar. No user dashboard was modified for testing.

Evidence: [Folder badge](folder-badge.png), [renamed dashboard](renamed-dashboard.png), [snapshot and sidebar](snapshot-and-sidebar.png), [owner navigation: project](open-saved-project.png), [owner navigation: wiki](open-saved-wiki.png).
