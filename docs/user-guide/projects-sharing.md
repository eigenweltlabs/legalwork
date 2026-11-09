# Projects and sharing

Open in LegalWork: [Projects](legalwork://app/projects).

A project is the working context for a matter or other body of work: its files, details, notes, tasks, reviews, calendar and chats. Use the visible project navigation to choose the available surface.

## Create and set up a project

Open **Projects** and use the create action. Choose the name, an existing local folder or the offered project location, and optionally link folders from connected storage. Remote folder choices appear only when storage is connected. Below the name, **Links · optional** offers **Add Matter**, **Add Client**, **Add Person** and **Add Organisation**. Each opens a searchable picker; only selected records take extra space. You can leave all four empty and create a project with just its name. **More** lists additional record types by name; **New field** adds a project field, including text, number, date, selection or a link to Back Office records. Use **Customize fields** beside these actions to edit field names, types and contents together, including custom roles and selection rules. The compact **Template: …** control stays visible below the links.

Choose **Add Matter** to search by matter name, client or file number. Each result shows its clients and file number below the matter name. Recently selected matters appear first when you open the picker; other matches are alphabetical. These local preferences are separate for each account and directory. Use the arrow keys and Enter to select a result, or click it. Select several matters when the template allows it; selections are applied immediately to the project draft. Remove one with its small remove button.

If a matter is missing, choose **Create a new matter** in the search results. Your search supplies its starting name. The compact form initially shows **Name**, **Clients**, **File number**, any additional required fields and fields constrained by selection rules. It uses the same field configuration as **Create** in Back Office, which a model editor can adjust under **Back Office > Data model > Matters > Settings**. **More details** reveals the remaining fields. Choose clients with search, arrow keys and Enter; their selection applies immediately without an Apply step. A missing client can be created from that picker without losing the matter draft. Use **Create and select**, or **⌘Enter** on macOS (**Ctrl+Enter** elsewhere), to save the record you are creating. Plain Enter in the name or file number does not save the form. The form explains that the matter remains in Back Office if you later cancel the project. The new matter is selected automatically, and the project name and other inputs stay in place. Finish with **Create project**.

For a direct client, person or organisation link, choose its **Add** button, search by name and select with arrows and Enter. Selections apply immediately to the project draft. Use **Create [record type]** if it is missing; the same short creation form and ⌘Enter / Ctrl+Enter shortcut apply. Escape closes the picker; remove a selected record with its ×. These links are independent of a matter: linking a client directly does not create or change a matter. Existing template fields and selection rules are preserved. Unselected options do not add extra empty fields.

All links are optional. Existing records can be selected with read access; creating a new one requires Back Office editing permission. The template's selection rules remain in effect. A template without a matter field receives one only when you choose a matter. Unavailable or archived records cannot be newly assigned. If project creation fails, its selections stay in the dialog. A matter explicitly created with **Create and select** remains in Back Office if you later cancel the project. For an already initialized project folder, change its linked records from **Project Home** instead.

LegalWork keeps its engine files and project state in its own local application-data folder. When you choose an existing document folder, your documents stay there. For a project without a chosen folder, LegalWork creates a local **files** folder for its documents. Downloads, saved recordings and exported images go to the project's document folder; temporary processing files stay in local project storage.

Upgrading moves the existing `.opencode` and `.legalwork` folders, including saved project data, attachments and wiki references. Saved chats keep their identities. Wait for migration to finish before running a chat or scheduled task. If you remove a local project from the project list and later add the same document folder, LegalWork reconnects its retained local project data. A disconnected document drive still needs to be reconnected to open or save the documents on it.

During migration, the startup screen shows the current stage and project, with actual file, byte or chat counts. The progress bar measures the current stage; it is not an estimate of time remaining. While LegalWork is still finding the total, the bar shows activity and the amount already processed. Keep LegalWork open until migration finishes. If migration reports an error, restart LegalWork to resume; do not delete its data or recovery copies. An unavailable document folder remains pending until it is reconnected.

**Set up from existing files**, when selected, starts an assistant chat to inspect the chosen material and establish the project. It can fill supported project details, identify concrete tasks and add useful source notes. Leave it off to create/link the project without starting that work. Review any extracted details and dates against their sources.

On **Project Home**, edit project details inline. Enter or leaving a text field saves; Escape cancels. Use **Add Matter**, **Add Client**, **Add Person** or **Add Organisation** to choose existing records or create missing ones, then **Link to project** (⌘Enter / Ctrl+Enter). These actions preserve your own named roles and other fields. Clients from linked matters appear with **via [matter name]** only when they are not already linked directly to the project. If every client is already assigned, the entire section is hidden. Removing a direct link reveals the client here again if its matter relationship remains; no records or relationships are deleted.

**New field** and **Customize fields** use the same editor in Create project and on Home. **Field name** is the label shown on the project, such as Intake status. **Field type** determines what it can contain: text, a number, a date, one of your options or records from a Back Office object. **Content** is the actual project value, such as Awaiting documents. Enter it immediately or leave it empty and save the named field. For a selection field, enter its comma-separated options before choosing a content value. For a record field, search/select records or create a missing record. The Save button has no keyboard badge; ⌘Enter / Ctrl+Enter remains available.

New custom fields and named record roles appear immediately on Home and in the project draft, even with no content. Click **Enter content** or **Choose records** to fill them. Clearing their content leaves the row available. Only empty standard matter/client/person/organisation rows are hidden because the corresponding Add actions already offer them. **More** lists additional record types; existing fields are edited where they appear, not offered again as types.

In **Customize fields**, a record field's optional **Selection settings** hold single/multiple cardinality and selection rules. Its name applies only in this project: a People field called Witnesses still selects People records. You can fill this role in the same editor; no separate trip through More is needed. Click a linked record's name on Home to change its selection; its arrow opens the record in Back Office. Each × removes only that link, leaving the record and other links intact. Unavailable records are marked without showing copied names. Links from another directory cannot silently be reassigned to the current one.

During project creation, **Template: …** supplies the starting fields; Add selects actual records. Changing the template keeps entered values and custom fields and replaces empty suggested fields. **No template** starts without suggested fields and does not erase your entries. On Home, the selector inside Customize says **Choose a template to apply…** because it applies fields without claiming which template the project previously used.

Project edits keep the starting version while an editor is open. If another window changes the project, saving keeps your draft and reports the conflict instead of overwriting newer data. **Load latest fields** (or **Load latest value** for an inline value) replaces the draft with current data so you can edit again. Cancel leaves the saved project unchanged.


**Save to defaults** copies field definitions for future projects without their current values. **Settings > Customization > Projects** manages metadata templates and the default template used during creation. The Legal Matter starter contains only a Matters reference, supporting one or several matters. Matter reference, clients, subject, practice area, status, opening date and other matter details stay on the Back Office matter or its related records. Open the matter to view or edit them; they are not copied into project metadata. Internal, contract and research templates retain their project-specific fields and references. Untouched older starter templates upgrade to these definitions; customized templates and existing saved project values remain intact. Reapplying Legal Matter removes empty suggested fields while retaining entered values and custom fields. Changing to an incompatible field type shows a standard notice that its existing value will be cleared when you save. Compatible values are kept. Cancel leaves the saved project unchanged. Switching a populated record field from several records to one also clears its value with the same notice. Existing saved project schemas keep their own definitions.

On **Projects**, use **Filter** to choose a metadata field. Record fields offer searchable record names, **Is**, **Is not**, **Is empty** and **Is not empty**. Several selected records match any of the selected choices. Saved filters follow record identities, so renaming a client does not break them. Only records available in the current directory are offered.

### Filter a record field's choices

Open **Project Home > Project details > Customize fields** and choose a Back Office object as a field's type. Under **Selection rules**, choose **Add rule**. Each row reads from **Field** to **Condition** to **Value**, for example, Organisation type | is | Court or Public authority. The value button opens the searchable picker. With several rules, choose **All rules** or **Any rule** after **A record must match**. The count below previews how many current records will be available in the project picker; it does not select or assign any records. The value picker uses the current model options, including user-created types and custom objects. Search and edit choices without losing your position in the field editor. Remove all conditions to allow all accessible records. These settings define the choices; select the actual records under **Content** in the same editor or through the corresponding field on Home.

The starter Responsible and project-owner fields require Active people with one of the initial team-member types. A new person of an allowed type becomes selectable automatically. After adding another team type, add it to the field's Type filter or remove that restriction as appropriate. Court / authority accepts organisations typed Court or Public authority. A responsible-partner field can target People with Type Partner and Active Yes. Choose multiple records for a matter-team field.

Filters constrain new selections. If someone later becomes inactive, changes type, or falls outside a changed filter, their existing assignment stays attached and can be opened or removed. Removing a selection and saving means adding it back requires matching the current filter. The assistant's eligible-record search and metadata writes use the same rules. Filters are saved with the field definition and travel with project metadata sync. Project-list filters remain available to find projects by their selected records.

## Use the project pages

| Page or section | How to use it |
| --- | --- |
| Home | Start a chat, inspect project details, notes, linked folders, recordings and upcoming deadlines. |
| Files | Browse/import local documents and open supported editors. Linked storage keeps its own connection and save rules. |
| Chats | Find and reopen this project's conversations. |
| Tasks | Track and assign work belonging to the project; open a task to change its status or attach a result. |
| Calendar | Review dates and supporting deadline records. |
| Tabular Review | Create or reopen a saved document-comparison table. |
| Dashboards | Open saved live dashboards or snapshot reports. |

Project personalisation sets instructions for this project. Check it when the assistant behaves differently between matters. Clearing the project instructions restores the global defaults. Notes are reusable project context; a new chat does not automatically establish every detail from every previous chat as fact.

## Linked folders

Use **Linked folders** on Home to add or remove references to connected storage. Linking grants access only through the existing connector and its permissions. It does not copy the whole source, create a connection for another person or grant them provider access. Removing the link leaves the source folder intact. A disconnected service or moved folder can make a saved link unavailable.

## Share with colleagues

1. Select **Share** beside the project name on Home.
2. Add named colleagues or **Everyone in your firm**. The latter also covers people who join the firm later.
3. Expand **What is shared** and review the switches for documents/folders, reviews, notes, tasks, calendars, recordings and project details.
4. Save and check the displayed sharing/sync status. Colleagues with access receive a local project copy through the firm's service when supported.

Only the owner changes the audience and sharing scope. Members can edit shared project content and can **Leave project**. Sharing Tabular Reviews includes their referenced documents even if general document sharing is off; calendar attachments have a similar exception. Chats are shared separately and do not sync merely because their project is shared.

To stop sharing, the owner removes every person and the whole-firm audience, then saves. Read the confirmation: the owner's local project remains, while members lose the shared copy subject to the app's handling of unsent edits and pre-existing folders. Leaving a project is different from deleting source documents in connected storage.

Removing a downloaded shared copy removes its LegalWork-created document folder and local project data. A folder you connected yourself remains yours. If the downloaded document folder is unavailable, reconnect it and retry removal; LegalWork keeps the project while cleanup is pending.

## Offline work and conflicting changes

For projects in cloud-synced folders, LegalWork requests **Keep Downloaded** for the hidden `.opencode` and `.legalwork` folders when the storage client supports it. These contain project configuration, project details and custom capability files. The request covers existing files; new files inherit the folder's offline setting. Documents outside these two folders keep their current storage settings. Files still sync between devices, and the initial download or updates from another device can take time.

If project setup still waits for cloud files, open the project's folder in Finder or File Explorer and check both folders in the storage client's menu. On Mac, press **Command–Shift–.** to show hidden folders, then choose **Keep Downloaded**, **Always keep on this device**, or the provider's offline action. On Windows, right-click each folder and choose **Always keep on this device** where offered. Google Drive uses **Offline access > Available offline**. The storage client must be connected, and the computer needs enough disk space. Older clients and streaming drives may require this manual step.

Offline edits remain pending until the service accepts them. A missing folder pauses sync instead of treating all its documents as deleted. Sync errors or an older firm service can leave changes pending; inspect the Home banner rather than assuming sharing succeeded.

When edits overlap, use the offered **Keep both**, **Use the other version** or **Keep mine** choice after comparing them. Keep both preserves a separate copy. A pending sign-out or access-loss decision can ask how to preserve unsent work. Resolve it before assuming that signing out has backed up those changes.

Related: [Chats](workspaces-chats.md), [Files](files-documents.md), [Calendar](calendar.md), [Tabular Review](reviews.md).
