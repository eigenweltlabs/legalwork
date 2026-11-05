# Dashboards and reports

Dashboards and reports are saved files in your project or wiki. Project Files and the file sidebar show their readable titles and dashboard icons. The **Dashboards** folder has a dashboard badge; reports use **Reports**. A live dashboard queries its source wiki, while a snapshot keeps the reviewed data from a particular time.

## Create and save

1. Open a chat in the intended project or wiki. Ask for a dashboard and identify its sources, for example, "Create a dashboard of matters from this wiki, grouped by responsible lawyer and status."
2. Review the preview and its source records. Generation alone does not save a file.
3. Choose **Save** to save directly into the originating project or wiki. An update preview saves back to its original file, provided that version has not changed.
4. Reopen the file from the project's **Files > Dashboards**, the file sidebar or the wiki explorer. Both file explorers refresh after saving.

## Assistant briefings and embedded charts

In the Personal Assistant, requested reports and scheduled briefings can be saved directly in its own workspace. They appear as document cards that you select to open beside the chat. This does not publish to a shared wiki or another project. Ordinary project and wiki generation continues to offer a preview with **Save**.

A Markdown briefing can embed a saved chart while keeping the summary, email links and task checkboxes editable. Select the embedded chart's **Open in tab** button to expand it. Report and dashboard cards use their readable titles rather than internal filenames. Priority email links open the original message in its provider; task links open the task in LegalWork.

Cards labelled **Dashboard** or **Report**, including cards from links in a reply, open the rendered document beside the chat. The underlying `.view.json` file is its saved format, not a code document. Ordinary JSON files still open in the text editor.

To embed an existing saved view, ask the Assistant to add it to your Markdown file. The file keeps a `legalwork-view` fenced reference, so reopening the document loads that same view. Source mode preserves the reference. Removing the block removes the embed, not the saved report file. An unsaved preview cannot be embedded as a saved chart.

## Save an independent copy

Select the arrow beside **Save** or **Saved** to open **Save a copy**. Enter a title, choose **Projects** or **Wikis**, select a destination and choose **Save a copy**. Saving into a shared wiki makes the copy available to its members. Only writable wikis are offered as new destinations.

Verified existing copies appear under **Already saved in** and are excluded from new destination choices. Choose **Open** beside a location to switch to that project or wiki and select the saved dashboard. Copies are independent: editing one does not update the others. Edited, deleted or inaccessible copies no longer count as the same saved version. If locations cannot be checked, use **Retry**. Clearing local copy history does not delete saved files; externally copied files are not automatically associated with that history.

## Rename, export and import

Use the file's menu in Project Files, the sidebar or the wiki explorer and choose **Rename**. This changes the visible dashboard title while preserving its program, data and `.view.json` filename. A heading inside the dashboard content is separate from its file title.

Use **Export snapshot** to download a portable `.view.json` file with frozen data. Import it using the project's add-files or drop action, or add it to a wiki. Explicit imports and copies through LegalWork receive independent identities, including repeated imports and folder copies. Keep the `.view.json` extension. Raw operating-system or synchronization copies retain their identities and may be reported as conflicts.

## Refresh and resolve conflicts

Saved dashboard tabs reconnect automatically when you restart the desktop app. A loading indicator appears while the local connection starts. If a view belongs to another server, open it from its original project or wiki to reconnect.

**Live dashboard** and **Refresh data** mean the view queries the source wiki. **Snapshot** with its data timestamp and **Reload saved file** mean the data is frozen. Cross-owner copies retain snapshots and source attribution; same-wiki copies can retain live queries. Imported files never silently run another wiki's queries against the destination. If an import requests a snapshot, export one from its source first. Source links can be unavailable when the original server is not connected, while the saved data remains readable.

If the original changes before an update preview is saved, LegalWork preserves the existing file. Choose **Open latest version** to inspect it or **Save a copy** to keep your preview separately. Some live dashboard boards allow property changes; those update source records and require access and matching revisions. Reports and generation previews are read-only.

An empty dashboard can mean missing fields or no matching records. A load error is not an empty dataset. Inspect the source records and query scope before changing the presentation.

Related: [Wiki](wiki.md), [Projects](projects-sharing.md), [Files](files-documents.md).
