# Remote folders in projects

A project stores references to existing storage folders. Creation optionally selects a local folder and links several remote folders in the same source area. Remote choices are hidden when no storage source is connected. **Set up from existing files** is an opt-in toggle for either source type, or both: the user decides whether the chosen folders contain material to establish the project. With the toggle off, creation does not start an agent session. With it on, creation opens the first session; exploration does not happen in the creation HTTP request.

During setup the agent discovers the project's actual metadata schema and existing contents with `legalwork_project_get_details` and `legalwork_project_list`, then reads accessible documents with the existing storage/document tools. It fills supported values with `legalwork_project_set_metadata`, preserving custom field definitions and existing values. Concrete outstanding actions become tasks with `legalwork_task_create(linkToProject=true)`. Useful source notes can be added sparingly with `legalwork_project_create_note`, with attribution and duplicate checks. Unknown values stay empty; no generic checklist or guessed deadlines are needed. Finally the agent rereads the revision and calls `legalwork_project_complete_setup` to name the project and finish setup. No separate project summary is generated, saved or injected into later sessions. Renaming alone is not completion. `initialization: pending` survives an interrupted first session; a later session can finish it. Local-only setup records its completion status with an empty remote folder list.

Project Home → **Linked folders** adds/removes references and checks access. Source errors are not interpreted as empty results. Unlinking and project deletion make no remote mutation calls.

## Storage contract

`StorageAdapter.folderReference(path)` and `resolveFolder(reference)` optionally provide native identity and current-path resolution. Providers must recheck the caller's access and configured root during resolution. Providers without these methods use exact paginated folder lookup and path references; their UI warns that moves/renames need relinking. Box and Dropbox implement native IDs. Account roots are bound to their namespace; shared native IDs can resolve under another authorized member's namespace.

The reference records a UUID, stable connection ID (`team:<UUID>` for team connections), organization where applicable, a non-secret connection-namespace fingerprint, folder ID/path/name and native namespace where available. New providers implement the adapter contract; project code has no provider switch.

Project tools use read-only virtual connection roots named `project:<folder UUID>`. Relative paths, recursive filename search, native search, pagination and document reads reuse existing storage routes. The wrapper rejects traversal and filters provider results to the linked subtree. Omitted search connections default to linked project roots. Explicit other connections remain possible when the user asks. No LegalMemory dependency, semantic index, folder mirror or local-to-remote document synchronization is introduced.

## Sharing and permission boundaries

Project configuration (`remote`) travels through project subscription sync separately from document/metadata scope. It contains only folder references and setup status. Previously saved summaries are discarded when old records are read. The platform compatibility field is sent empty, so no summary is uploaded. The stable team project identity is the existing `syncProjectId`. Folder configuration uses the existing timestamp conflict rule; a newer configuration wins as one unit.

Credentials and source-workspace bindings stay in the member's server configuration. Personal connections require an explicit device-local binding to the exact folder identity; a synced edit cannot broaden that grant. Team references resolve through the member's current subscription and installed connection, reusing that member's existing sign-in where available. Every operation rechecks the connection, namespace and provider permissions. A mapping does not install a connection, sign someone in, share a source folder or grant new source permissions.

The companion platform migration `0028_project_remote_folders.sql` and API must be deployed for team sharing. An older platform cannot silently discard mappings: sync reports that it needs an update and retains the pending operation. Local linking and setup work without team sync.

## Checks

Tests cover creation, exact/paginated lookup, native-ID rename and out-of-root moves, account roots, source permissions, scoped reads/search, no remote mutation on unlink/delete, credential rejection, local grants, automatic agent folder scope, and two-machine configuration sync with document sync disabled. Platform integration tests exercise the migration, project visibility and stale-update handling against PostgreSQL.

Manual desktop reproduction (requires restarting the desktop server after the build and a configured model; remote steps also need connected storage):

1. Configure a custom default metadata field. Open Create project. Choose an existing local folder, remote folders, or both. With no connected sources, remote choices are hidden. Enable **Set up from existing files** and create. Repeat with the toggle off to confirm that linking alone does not start setup.
2. Confirm the first session opens and runs. It should discover custom metadata fields, read documents, fill supported values, attach concrete outstanding tasks to this project, and selectively add useful source notes. It should update the project name and mark setup complete last. Verify unknown values and existing source files remain unchanged. Open a later session and ask a document question without specifying a location.
3. In Project Home → Linked folders, add/remove links and inspect availability. Disconnect the source or move a path-only folder; the agent and dialog should explain the limitation. Unlinking must leave the source files untouched.
4. After deploying the platform migration/API, share the project with document sync off. Another member with the team connection and their own source authorization should receive the same folder references. A member without source access should see an access error.

Live provider OAuth and the model-driven desktop flow were not exercised in this implementation pass; the automated end-to-end test uses a local WebDAV fixture, and native Box/Dropbox identity tests use provider responses. No UI recording is attached for those live flows.

The local/remote setup revision adds regression coverage for custom-field validation, local-only initialization and task project linkage. App/server typechecks and the server build passed; these new tests and live setup were not executed at the user's request.

Provider identity semantics: [Dropbox team files guide](https://developers.dropbox.com/en-us/dbx-team-files-guide), [Box folder metadata](https://developer.box.com/reference/get-folders-id/).
