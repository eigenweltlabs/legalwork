# Document workspace and original-file autosave

Local branch: `feat/side-by-side-documents`, originally based on `dev` at `f64d51b9`, now merged with `origin/dev` at `b8845a43` (5 October). Nothing has been pushed or published.

## Behavior

- Each editable local DOCX has an **Autosave** switch beside Save. It defaults to off and remembers the choice for that workspace/path on this device.
- When enabled, changes are serialized after 1.5 seconds without editing, or within 10 seconds during continuous editing. Writes update the original workspace file through the existing LegalWork binary-file API. This is not just a recovery copy or a download.
- Saves run one at a time. Edits made during an in-flight save remain dirty and trigger another save. Turning the switch off cancels pending autosaves; it cannot undo a write already in flight. Manual Save remains available.
- Failed writes pause automatic retries, show a persistent message and retain the draft. A successful manual save, or switching off and on, retries/resumes autosave. Existing modification-time conflict checks prevent overwriting an externally changed file. Retrying does not bypass a conflict.
- IndexedDB recovery remains separate from original-file saving. Restoring a draft honors its original conflict baseline and the current autosave preference. The recovery prompt explains this.
- The first save retains the loaded original in local history. Rapid autosaves share five-minute checkpoints rather than consuming all five retained versions within seconds. Manual saves remain distinct. A history browsing/restoration UI is still outside this change.
- Autosave is currently offered for editable local workspace DOCX files. Connected-storage checkout/publish flows, remote/read-only documents, PDF, Markdown, spreadsheets and presentations do not acquire this switch.

## Split workspace — free layouts (5 October)

The preset menu is removed. Drop a document tab, Project File or Memory Drive file at the **left, right, top or bottom edge of any pane** to split that pane in half. Drop in the centre or its tab strip to add/move the document as a tab. Right-click a tab for the same four split directions (when that group has another tab) or to move to another existing pane. No new keyboard shortcuts are added. Fullscreen remains available, with shared controls at the overall top-right even in nested layouts and docked headers.

The outer quarter of each pane chooses the nearest relative edge; the middle half is the centre target. The indicator previews the destination half with a rounded solid outline, translucent fill, compact label and a short reduced-motion-aware transition. Its inset keeps it away from document toolbars. The temporary drag shield still places it above PDFium and other iframe viewers; it clears on drop, drag end, Escape, leaving the window or blur.

Up to **six visible panes** are allowed. Additional documents can remain as tabs. Relocating the sole tab of an existing pane is allowed at the limit because its old pane disappears. A drop that would actually create a seventh pane is refused with an explanation; it does not silently replace a document or change the layout. Splitting a pane's only tab against itself is a no-op, not a duplicate view.

### Moving and closing rules

| Action | Result |
| --- | --- |
| Close an inactive tab | Remove only that tab; keep the visible document and geometry. |
| Close/move the active tab when its group has other tabs | Activate the next tab to its right, otherwise its left neighbour. |
| Close/move the last tab in a pane | Its sibling fills their shared rectangle. A sibling subtree expands as a unit, retaining its internal proportions. |
| Close a bottom pane in one column | The pane/subtree directly above fills that column; the other column stays in place. The reverse applies to top/left/right panes. |
| Move the last tab from the original main pane | Allowed; no special main-pane exemption and no arbitrary global rearrangement. |
| Drop onto the centre of another pane | Move once, activate at the destination, and collapse the emptied source. Existing destination tabs remain available. |
| Move a visible dirty document or expand a surviving sibling | Keep the same editor host, draft and Undo history. |
| Hide or close a different dirty editor | Run its existing discard guard before changing the tree or tab membership. Cancellation leaves both unchanged. |
| Close the focused document/pane | Focus its replacement tab or the nearest surviving sibling, rather than an unrelated first pane. |
| Finish a cloud import after its target closes | Do not recreate the removed pane; explain that a new drop target is needed. |
| Drop multiple files at an edge | Create one split, then add the remaining files as tabs in that group. |
| Close the final tab | Return to one empty viewer. |

Each split stores its own direction, children and divider ratio. Pane ids stay stable; surviving split ratios are remapped when a child is split or removed. Delayed resize callbacks from obsolete children are ignored. Only visible document editors are mounted. The existing one-editor-per-file ownership and controlled cross-window handoff are unchanged; this is not collaborative editing or cross-window tab dragging.

Workspace tabs, arbitrary split geometry, selected tabs and divider ratios survive reload. Old two-pane and preset layouts migrate, including their proportions. Transient evidence views and connected-storage working copies still do not restore. Removing those leaves collapses just their branch. Browser/task/workflow tabs remain in one integration group, which can sit anywhere in the tree. Detached windows retain their independent sessionStorage layouts.

### Validation

- **807 app tests passed**, including the final stale-resize guard; **50 focused tests** and app typecheck also passed. Production UI build and the **5,088-key English/German audit** passed. Existing build chunk-size warnings remain.
- The geometry test enumerates every binary split shape/orientation up to six panes and verifies **9,373 individual leaf removals**. Store tests cover 500 successive operations, all four edges, left/right stacks, pane limits, relocation at the limit, cancelled dirty-document actions, neighbour selection, restoration, malformed persisted data, browser integration and cloud working-path retention.
- Real browser checks with disposable documents: two stacked panes in both columns; four-direction file/tab drop listeners; six panes and rejected seventh pane; relocation at the cap; close/collapse; docked headers; a resized 55/45 divider and four-pane tree restored on reload.
- A typed unsaved DOCX draft survived multiple cross-pane moves, promotion after closing the pane beneath it, and fullscreen/restore. Undo removed the edit, Redo restored it, and Save wrote it once. No false Edit here appeared.
- An isolated Electron instance visibly rendered the rounded preview above native PDFium and completed the synthetic drop. Actual pointer automation did not establish a successful native drag, so native mouse/Finder gestures remain a manual check. A connected Memory Drive download/publish was not exercised; its routing and retained working path are covered by tests.
- No client documents, DOCX selection-rendering CSS, autosave cadence or multi-window ownership code were changed.

![Four freely arranged panes in fullscreen, using synthetic documents](./document-workspace-free-layout.png)

![Rounded drop preview above native PDFium, using synthetic documents](./document-workspace-free-split-pdf.png)

## Editing in multiple app windows

One view owns editing for each original file; other views are read-only and refresh after successful saves/autosaves. **Edit here** requests a handoff. The current owner blocks new input, waits for in-flight writes, saves any later edits, and drains recovery checkpoints before releasing ownership. A failed save refuses the handoff and retains the original draft. The receiving view reloads the original before enabling editing. A handoff does not transfer Undo history; moving panes within one window still preserves it.

The server returns an opaque canonical file identity, so workspace/directory aliases share an ownership key. Web Locks provide exclusivity in the app's origin/profile; BroadcastChannel carries handoff/save notifications. Closing a mounted editor drains pending work before releasing; renderer termination releases the browser lock. A waiting request times out without forcibly taking a dirty editor. DOCX recovery is accessed only by the owner under the canonical key, with migration from the former workspace/path key. Autosave preferences synchronize between windows.

Both raw and text original-file writes now serialize the baseline check and replacement within one server process, preventing two overlapping requests from both passing the same baseline check. Existing text merge/conflict semantics remain intact. This also protects writes from clients outside the cooperating renderer flow when they supply a baseline.

Scope: ownership covers these app views in the same profile/origin, not Word, direct filesystem tools, other browser profiles, or independent server processes. Existing conflict checks remain necessary. Live refresh happens after saving, not for every unsaved keystroke. The desktop agent-control server still targets its existing main window; it does not silently redirect commands to a detached window. An action aimed at a read-only document is refused. This is not collaborative editing. The updated app requires the updated server's file identity response; unavailable identity/locking leaves the file read-only.

## Validation on 5 October 2026

- Full app suite: **789 passed, 0 failed**, 116 files. New tests cover ownership/handoff/failure/draining, independent files, three-pane restoration, explicit empty drop targets, and dirty-pane collapse guards.
- File API integration suite: **8 passed, 0 failed**. Concurrent raw/text writes with the same baseline return one success and one conflict in ten repetitions. Canonical identity survives atomic replacement and matches a directory symlink alias.
- App/server typechecks and English/German audit passed (5,084 keys each). Production UI build passed with existing large-chunk warnings; whitespace checks passed.
- Real DOCX editor and server in two browser views: clean handoff, dirty handoff, read-only save refresh, failed-save refusal, and an in-flight save followed by later edits and a second drained save all passed. The receiver contained both edits. Autosave-off persisted across the handoff. Markdown dirty handoff also saved and transferred the latest text.
- Two isolated Electron BrowserWindows using the installed runtime: both views initially showed the same documents, only one could edit each file, and **Edit here** transferred Agreement while Precedent remained independently editable in the first window.
- Native Electron visual checks covered three columns, large-left/stacked-right, top-right controls, right-click tab actions, and the overlay above PDFium. Narrow-pane document actions now wrap rather than overflow beneath the adjacent pane.
- All fixtures were synthetic. Native mouse/Finder drag gestures, a live connected-storage publish, and Office-format handoff UI are not claimed as manually verified. No DOCX selection-rendering code, page-fit hook, layout stylesheet, editor version or patch was changed.

![Three document panes in the isolated Electron test workspace](./document-workspace-three-columns.png)

![One large document and two stacked documents, with controls at the top-right](./document-workspace-main-and-stack.png)

![A second Electron window owns Agreement while Precedent remains read-only](./document-workspace-window-handoff.png)

## Lifecycle follow-up — 5 October

The first ownership implementation could leave a reopened viewer read-only even without another window. Its one-time `ifAvailable` check ran while the previous local instance was still draining and releasing its lock. React StrictMode's effect teardown/recreation exposed this consistently with cached file identity. The review harness had omitted StrictMode, unlike the actual app.

Local disposals are now awaited by file identity before a new instance checks for another writer. Cleanup is idempotent and waits for the browser lock operation to finish, not merely the callback's release signal. It still drains pending writes/recovery and never steals a live writer. The harness now runs under StrictMode and has Hide/Show viewer controls. A regression test failed before this change and passes afterward.

Autosave's caption is 6px from its switch and separated from Save by 14px. Save-status text reserves the width of the unsaved label, keeping the adjacent controls still when status changes. The save timing and dirty-detection logic are unchanged: idle synthetic documents stayed saved; a real edit produced one save, and expansion generated no new change events. The user also confirmed the reported status flicker had stopped.

Validation: **791 app tests passed**, app typecheck/build and whitespace checks passed (existing build chunk warnings). Three consecutive Hide/Show cycles produced no Edit here button; a genuine second view remained read-only, and a dirty DOCX handoff saved and transferred the new text. Save-button coordinates were identical in saved and unsaved states. No selection-rendering change.

![Save controls and per-file editing ownership after the lifecycle fix](./document-workspace-lifecycle.png)

## Tab and save-control stability — 5 October

Document tab positions no longer use the shared spring during pane resizing. The override is scoped to the viewer's tabs; native file dragging and browser-tab drag controls remain unchanged. Before the fix, a divider step left the tab with a temporary 30.7px translation. Afterward, immediate measurements in both resize directions and in the expanded workspace returned no translation.

The original-file Save caption stays constant while saving; the adjacent status reports progress and the disabled button exposes `aria-busy`. Busy saves no longer dim the button. Status text stays on one line. Previously, Save grew from 58.16px to 70.52px when its label became Saving, potentially changing flex wrapping. Held real-server saves now preserve the header, icon, Autosave and Save bounding boxes at 489px and 380px pane widths. An actual DOCX edit with Autosave enabled also preserved those boxes through saved → saving → saved at 435px. The button remained disabled while the write was held. These are synthetic fixtures; no user document was edited.

Validation: app typecheck and production UI build passed (existing build warnings); **23 focused tests passed** across `document-autosave`, `document-ownership`, `docx-document-state`, `document-layout` and `document-split-drop`. No save cadence, ownership, document-selection rendering or editor-library change.

Maximized-header analysis only: both the workspace overlay and the existing individual-artifact overlay use `mac:top-11`, leaving the macOS title strip visible. The session header independently renders chat and Project Files headings and does not consume expansion state. Recommended follow-up: hide those content-specific header elements and their interactions while expanded, retaining native window controls and a drag region; restore them on exit without unmounting chat/files. That behavior is not changed here.

![Stable tab and save controls during a held synthetic DOCX save](./document-workspace-stable-chrome.png)

## DOCX selection clipping repair — 5 October

The earlier selection investigation is now repaired in LegalWork's layout adapter for the pinned Eigenpal 1.8.3 editor. No editor package, existing package patch, document model, selection mapping or save code was changed.

The fitted scroll track could be narrower than the unscaled page stack. Eigenpal's overlay clipped otherwise correct selection rectangles to that track. The adapter now measures the native stack and extends **only the overlay's bounded paint clip** by half the excess width. Its coordinate origin stays unchanged, and the outer scrolling viewport still clips to the document pane. The stack is observed so wider sections and later page layout changes can update the bound; text/selection changes do not add a new subtree observer.

Resizing also exposed stale selection positions during the existing animated scale and the adapter's frame-delayed zoom override. The adapter now leaves Eigenpal's native zoom transform intact, cancels only the narrow-pane sidebar offset using the library's exported `SIDEBAR_DOCUMENT_SHIFT`, and disables the scale transition. Native selection geometry therefore sees the displayed scale immediately. This uses the installed package's source/types, not assumptions about a newer upstream API.

Validation with synthetic originals:

- Before: 26 of 33 selection rectangles extended beyond the clip at a 489px pane width. After: zero outside the effective clip at widths 217, 272, 326, 380, 435, 489 and 544px; selection remained aligned through divider resizing. The title rectangle differed from its painted text by less than 0.01px.
- Native 50% and 100% zoom, automatic 25% minimum zoom, and the 899/900/901px comment-rail boundary in both directions retained the selection and its alignment. Both horizontal and vertical split layouts and an expanded document were checked; comments were toggled in the wide view.
- A three-page fixture with tracked revisions, comments and a table produced 91 selection rectangles, none outside the effective clip; scrolling to page 2 retained them. A native mouse double-click and keyboard line selection worked. The caret at the left text edge in a 489px pane was inside the clip and exactly aligned with the text.
- **807 app tests passed**, including the 17 focused DOCX state, round-trip and performance tests; app typecheck, production UI build (existing warnings) and whitespace checks passed. No user document was edited.

![Selection across a narrow three-page synthetic document](./document-selection-fixed.png)

## Maximized header and remaining toolbar analysis — 5 October

The session's titlebar retains its native drag strip/window-control space while an entire document workspace or a single artifact is expanded. Its child headings, pane headers and controls become hidden, including from keyboard focus/accessibility; their portals remain mounted. Restoration brings the same headers back. A scoped CSS selector derives this directly from the existing expansion attributes, without adding a second expansion state or remounting chat/file browsers.

Verified in the running detached Electron document chat with Project Files open: expand workspace → chat/file headings disappear; restore → both return; expand individual document → both disappear; restore → both return. The original view was restored without editing its documents. The 807-test, typecheck and build results above also cover this change.

The user confirmed actual drag-and-drop works well. This is user acceptance evidence in addition to the earlier synthetic event/geometry tests; connected Memory Drive publication remains a separate unverified integration.

**Toolbar analysis only; no toolbar change:** `PanelHeader` wraps document actions below 400px, then forces one row from 400px upward. In the English synthetic DOCX view, 380/399px panes had an 82px-high header and no clipped controls; at 400px, the externally-open/close/expand buttons exceeded the right edge; at 435px, close and expand did; at 480px, expand exceeded it by 6.42px; at 489px all fit. This concerns LegalWork's Save/Autosave/file-action row, not Eigenpal's formatting toolbar or document content. File-size labels, language and available actions can shift the exact fit threshold. A future fix should make this app-owned row wrap according to its contents, and should leave the editor toolbar alone. No such fix is included here.

## Adversarial review corrections and upstream integration — 5 October

An Astra review of the complete branch found two draft-safety defects. A clean plain-text editor in Edit mode could remain writable after handing off its ownership, while its Save controls disappeared. Handoff now exits Edit mode even without a write; the source editor also receives an explicit read-only flag and rejects changes when it does not own editing.

DOCX checkpoints formerly included the API URL in their key, so an embedded-server port change could make a retained draft unreachable. Local workspace ownership and recovery now share the canonical file identity independently of transport ports. Local versus remote comes explicitly from workspace routing, not a hostname guess; remote endpoints, including loopback tunnels, retain separate namespaces. This also prevents two local URL aliases from holding independent locks over the same recovery record.

Recovery migrates prior loopback URL keys and the former workspace/path key in one IndexedDB transaction. It chooses the newest valid checkpoint, retains its conflict baseline, removes migrated aliases to prevent resurrection after Save/Discard, and retains superseded checkpoints in the existing bounded local history. It does not modify the original document or enable autosave. A targeted Astra follow-up found no remaining actionable issue in this revision.

The six new upstream commits add project calendars/deadline calculations, personalization, model-catalogue fixes, and Sync/provider/usage changes. They do not change the document pane or artifact directories or introduce a competing document split-screen implementation. `git pull --no-rebase --no-commit origin dev` required only additive English/German translation conflict resolution; both sets of keys were retained. Dependencies were installed with the frozen upstream lockfile. The pre-pull branch is retained as `backup/side-by-side-before-upstream-20261005`.

Validation of the combined result:

- **880 app tests passed**, 131 files; app and server typechecks, production UI build and the **5,451-key English/German audit** passed. Existing build chunk-size warnings remain.
- **8 artifact API integration tests passed** against isolated temporary state. The initial run had a socket `ECONNRESET` during concurrent writes; the full repeat passed unchanged with 202 assertions. This is recorded rather than hidden as a clean first-run result.
- Real browser views and CodeMirror: enter Edit on unchanged `Plain.txt`, hand off, confirm the former editor is gone; edit/save in the new owner and observe the former owner's read-only refresh. A second handoff saved and transferred an unsaved text draft.
- Real IndexedDB: old-port recovery preserved exact bytes and baseline; superseded checkpoints moved to history; unrelated-server draft remained intact; reloading the stable key worked; removal did not resurrect old aliases; an existing newer checkpoint won.
- Separate browser views using `127.0.0.1:5175` and `localhost:5175` shared one writer; Edit here transferred it and demoted the former owner.
- The merged Electron app started and restored the existing document layout. Client documents were not edited. No new connected-storage publication or renderer-crash simulation is claimed.

The development harness offers **Open plain text**, **Check recovery migration**, and the `?detached=1&localAlias=1` URL for the alias check. Its IndexedDB checks use unique disposable identities and clean them afterward. The known narrow action-row clipping remains intentionally deferred.

## Visible return action in expanded documents — 5 October

The macOS 44px title strip now contains a visible centered **Return to chat** button for an expanded workspace, or **Exit fullscreen** for an individually expanded document. Native window-control space and the draggable title area remain available. The button itself is not a drag region. Other platforms retain their existing edge-to-edge layout.

When an individual document is expanded inside an expanded workspace, only its return action is visible; exiting reveals the workspace return action again. Browser checks confirmed the top strip at y=0, both actions working, and the original panes restored. The actual Electron app also passed expand-workspace → click the new Return to chat button → restore. The screenshot below uses only disposable synthetic documents. The combined 880-test/typecheck/build validation above includes this UI change.

![Expanded workspace with a visible return action in the title strip](./document-workspace-fullscreen-return.png)

## Editor documentation checked

The pinned packages are `@eigenpal/docx-editor-react`, `core` and `agents` **1.8.3**, including this repository's existing patches. The [published React package documentation](https://www.npmjs.com/package/%40eigenpal/docx-editor-react) exposes change/save APIs and `useAutoSave`. The installed `dist/hooks.d.ts` documents `useAutoSave`'s localStorage recovery manager, with a storage key, recovery/discard operations and a save timestamp callback. It does not provide LegalWork's original-file persistence or conflict checks.

This implementation therefore uses the installed editor's change events and `save({ selective: false })`, through LegalWork's existing serialized save and revision checks. No editor upgrade or new dependency was introduced.

## Validation on 4 October 2026

- App typecheck and English/German translation audit passed (5,060 keys in each language).
- Full app suite: **763 passed, 0 failed**, 112 files. The initial sandboxed run could not bind localhost ports; the run with local-server access passed.
- Focused autosave, history, panel and connected-storage tests: **25 passed**. They cover off/on behavior, cancellation of queued writes, serialized saves with later edits, deadline saves, paused retries, history coalescing, draft guards and persistent pane restoration.
- Production UI build passed with existing large-chunk warnings. `git diff --check` passed.
- In-app browser with the real editor and real LegalWork server, using disposable synthetic DOCX originals: off retained an unsaved edit without writing; enabling saved it to the original; the saved DOCX was downloaded and parsed to verify its content.
- A held write completed while a later edit remained dirty; the next write persisted both edits. A simulated failed write paused autosave and preserved the draft; manual Save recovered.
- An external edit to the original file caused a real server conflict. The original retained the external marker and did not acquire the conflicting local draft. A fresh page offered that draft for recovery with the changed-file warning.
- Moving a dirty side DOCX to the main pane preserved the draft and Undo; Undo reverted the same edit after moving. Focused-document agent metadata selected the side document correctly.
- Expanded workspace, keyboard resize from 50% to 55%, tab/pane restoration and remembered autosave settings were verified. The divider returned at 55% after reload.

Native pointer tab drags did not establish a successful move through automation. Native Electron pointer gestures and drops onto native browser overlays remain manual checks; do not report them as passed. This round validates the real web editor/API path, not a full newly installed desktop build. During development, a harness hot-reload issue was corrected by disposing its React root; final checks use a fresh page. The existing native discard confirmation briefly blocked browser automation, so fresh pages were used for subsequent checks.

![Original-file autosave and expanded document workspace](./document-autosave-workspace.png)

![External modification pauses autosave while retaining the draft](./document-autosave-conflict.png)

## Reproduce

```sh
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app test:i18n
pnpm --filter @legalwork/app exec bun test tests/document-autosave.test.ts tests/document-version-history.test.ts tests/panel-side-pane.test.ts tests/storage-file-tabs.test.ts
pnpm --filter @legalwork/app test
pnpm --filter legalwork-server typecheck
pnpm --filter legalwork-server exec bun test src/artifact-files.e2e.test.ts
pnpm build:ui
```

For an isolated live check, run these in separate terminals from the repository root:

```sh
pnpm exec bun apps/server/scripts/document-workspace-review.ts
PORT=5174 pnpm dev:ui
```

Open `http://localhost:5174/document-workspace-review.html`. The server logs its temporary workspace directory, copies the synthetic fixture into two originals, and uses the real authenticated file routes on localhost:5175. The development-only page exposes failed/held writes, a release button, original-file readback and active-document metadata. **Hold writes** waits until **Release write** is clicked; turn holding off before releasing to let subsequent saves finish normally. The harness is not a production build entry and uses no model calls or client documents.

For file-drop checks, drag a fixture from the Project Files list to any document edge. The explicitly labeled synthetic-event buttons provide a separate check of the production drop listeners and the portaled editor path. Use **Preview right-edge drop** to inspect the indicator, **Drop precedent at right edge** to open the split and **Drop precedent into main** to move it back.

The bottom-edge buttons exercise vertical creation. **Dock tabs in header** reproduces the desktop header placement; use tab context menus or **Free split checks** to arrange panes. The latter sends explicitly synthetic project-file or tab drag events through the production listeners, with a selectable source, target and edge. **Open second window** opens an independent detached view using the same test files; use **Edit here** on a read-only document to test handoff. **Open note** supplies a synthetic Markdown fixture. Hold/fail controls affect writes originating in their own test view, so enable them in the editing owner when checking handoff failure or waiting.
