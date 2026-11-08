# Projects and sharing

Open in LegalWork: [Projects](legalwork://app/projects).

A project is the working context for a matter or other body of work: its files, details, notes, tasks, reviews, calendar and chats. Use the visible project navigation to choose the available surface.

## Create and set up a project

Open **Projects** and use the create action. Choose the name, an existing local folder or the offered project location, and optionally link folders from connected storage. Remote folder choices appear only when storage is connected.

LegalWork keeps its engine files and project state in its own local application-data folder. When you choose an existing document folder, your documents stay there. For a project without a chosen folder, LegalWork creates a local **files** folder for its documents. Downloads, saved recordings and exported images go to the project's document folder; temporary processing files stay in local project storage.

Upgrading moves the existing `.opencode` and `.legalwork` folders, including saved project data, attachments and wiki references. Saved chats keep their identities. Wait for migration to finish before running a chat or scheduled task. If you remove a local project from the project list and later add the same document folder, LegalWork reconnects its retained local project data. A disconnected document drive still needs to be reconnected to open or save the documents on it.

During migration, the startup screen shows the current stage and project, with actual file, byte or chat counts. The progress bar measures the current stage; it is not an estimate of time remaining. While LegalWork is still finding the total, the bar shows activity and the amount already processed. Keep LegalWork open until migration finishes. If migration reports an error, restart LegalWork to resume; do not delete its data or recovery copies. An unavailable document folder remains pending until it is reconnected.

**Set up from existing files**, when selected, starts an assistant chat to inspect the chosen material and establish the project. It can fill supported project details, identify concrete tasks and add useful source notes. Leave it off to create/link the project without starting that work. Review any extracted details and dates against their sources.

On **Project Home**, edit project details inline. Enter or leaving a text field saves; Escape cancels. Use **Configure fields** to add or change text, number, date, selection or Back Office record fields. For a record field, choose the object type, such as Clients, Matters or a custom object, and whether several records may be selected. Field settings contain definitions only. Close field settings, then click the value in the metadata row on Project Home, search for records, select them and apply. The picker matches Back Office table relations. Click a selected record name to change the selection; the small arrow beside it opens the record in Back Office. Unavailable records are marked without showing copied names. Records belong to the directory where they were selected; switching firm, platform or local computer does not automatically bind them to similarly named records.

**Save to defaults** copies field definitions for future projects without their current values. **Settings > Customization > Projects** manages metadata templates and the default template used during creation. The Legal Matter starter contains only a Matters reference, supporting one or several matters. Matter reference, clients, subject, practice area, status, opening date and other matter details stay on the Back Office matter or its related records. Open the matter to view or edit them; they are not copied into project metadata. Internal, contract and research templates retain their project-specific fields and references. Untouched older starter templates upgrade to these definitions; customized templates and existing saved project values remain intact. Reapplying Legal Matter removes empty suggested fields while retaining entered values and custom fields. Changing to an incompatible field type shows a standard notice that its existing value will be cleared when you save. Compatible values are kept. Cancel leaves the saved project unchanged. Switching a populated record field from several records to one also clears its value with the same notice. Existing saved project schemas keep their own definitions.

On **Projects**, use **Filter** to choose a metadata field. Record fields offer searchable record names, **Is**, **Is not**, **Is empty** and **Is not empty**. Several selected records match any of the selected choices. Saved filters follow record identities, so renaming a client does not break them. Only records available in the current directory are offered.

### Filter a record field's choices

Open **Project Home > Configure fields** and choose a Back Office object as a field's type. Under **Selection rules**, choose **Add rule**. Each row reads from **Field** to **Condition** to **Value**, for example, Organisation type | is | Court or Public authority. The value button opens the searchable picker. With several rules, choose **All rules** or **Any rule** after **A record must match**. The count below previews how many current records will be available in the project picker; it does not select or assign any records. The value picker uses the current model options, including user-created types and custom objects. Search and edit choices without losing your position in the field editor. Remove all conditions to allow all accessible records. These settings define the choices; select actual project values in the metadata row on Home.

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
