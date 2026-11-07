# LegalWork project storage proposal — migrate two folders intact

Date: 2026-11-07. Status: follow-up implementation includes wiki support-folder migration and review fixes in draft PR #405; native file tools retain standard OpenCode path resolution.
Source inspection: origin/dev at `65e42ac5b` (the existing source inventory uses this revision).
User constraints: migrate only `.opencode/` and `.legalwork/`; retain their names and internal layouts; no split into engine/state/workspace directories; no Move Files into LegalWork action.

## Recommended layout

Create one local LegalWork-owned home per project:

```text
<LegalWorkData>/Projects/<existing-project-id>/
  .opencode/                         existing tree, intact
  .legalwork/                        existing tree, intact
  files/                             content for NEW projects without an external folder
```

The local project home itself is the engine's native project location. There is no extra `engine/` wrapper. In this proposal, project home means the directory containing both hidden folders; it is distinct from the engine executable and shared engine process working directory.

Proposed production data roots:

- macOS: `~/Library/Application Support/com.eigenweltlabs.legalwork/`
- Windows: `%LOCALAPPDATA%\com.eigenweltlabs.legalwork\`

Resolve these via platform directory resolution, independently of Documents and Windows roaming Electron userData. Keep development/test profiles separate. Verify the actual backing location is suitable local storage; a network-backed redirected profile is not made local by its directory name.

Platform references checked during the original inspection: [Apple file-system guidance](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html), [Windows Known Folder IDs](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid), [Electron app paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname).

## 1. Exactly what moves

For an existing content folder, migrate the two complete directory trees:

| Before | After |
| --- | --- |
| `<content-folder>/.opencode/` | `<local-project-home>/.opencode/` |
| `<content-folder>/.legalwork/` | `<local-project-home>/.legalwork/` |

Keep all descendants in the same relative location. Examples:

- `.opencode/legalwork/reviews/` stays `.opencode/legalwork/reviews/`.
- `.opencode/legalwork/inbox/` and `outbox/` keep their existing locations inside `.opencode`.
- `.opencode/legalwork/prepared-documents/` and `jev-search/` remain where they are inside that tree.
- `.legalwork/project.json` and `project-file-links.json` remain directly inside `.legalwork`.
- `.legalwork/attachments/`, `storage-downloads/`, `email-drafts/` and `calendar-drafts/` remain in their current relative locations.
- Recovery data, import backups, capability resources and unknown files inside either tree are preserved. Do not turn this relocation into a cleanup or dependency-pruning project. Resolve linked/special entries explicitly rather than copying arbitrary external targets unnoticed.

No new `.legalwork/state/` or `.legalwork/workspace/` directories are introduced. Normal path consumers retain their existing suffixes; the selected base directory changes. Generated configuration and recorded absolute paths may still need deliberate updates to the new base. Intact means no internal reorganization, not a promise that every saved absolute path can remain valid unchanged.

The following are outside the migration:

- Ordinary project content, including existing Documents folders, Notes, visible Downloads, reports and other user files.
- Existing shared `runtime.sqlite`, `opencode-engine-v2.db`, shared engine-home and credential stores. Keep their physical locations unchanged in this change; session records may need an ownership/location migration, but the database file itself is not relocated or duplicated.
- Existing browser-download staging outside these two trees and task attachments stored globally.
- Root-level `opencode.json[c]`, `.claude`, `.agents`, Git repositories and unrelated files outside the two named trees.

Existing browser-download and task-attachment paths remain unchanged. New attachment and download flows that already write under `.opencode` or `.legalwork` use the new project home while keeping their existing relative suffixes. Audit any runtime references to files outside the two trees without silently expanding the migration scope.

## 2. Two directory roles, one stable project identity

The application-owned project registry needs to represent:

```text
id                = existing project ID, preserved
localDirectory    = <LegalWorkData>/Projects/<id>
contentDirectory  = existing connected document folder
```

These are proposed logical fields, not a claim that this exact schema already exists. The engine location is `localDirectory`; its native configuration is discovered in `localDirectory/.opencode`. All LegalWork-owned hidden-folder paths also resolve against `localDirectory`.

For a new project without an external folder, `contentDirectory` is `localDirectory/files`. Existing projects keep their current content directory, including those currently under Documents/LegalWork/Projects. No new move-files action is added, and no existing visible content is moved automatically.

Project IDs must not be recalculated from the new directory. Creation currently derives IDs from paths; migration must preserve existing IDs and new projects should receive a permanent generated ID. Keep sync IDs, schedules, tasks and existing associations intact.

## 3. Connected content folder: exact behavior

Example:

```text
Local project home: <LegalWorkData>/Projects/p123/
Connected content: /Volumes/Firm/Matters/Acme/
```

LegalWork persists the chosen content path and its project-scoped access in its application-owned registry. This is a saved reference with authorization. It is not a symlink, junction, shortcut, new host OS mount or copy of the folder. Do not treat agent-editable project metadata as authority to grant a new external folder.

Use explicit root resolvers throughout the server and desktop:

- Engine settings, capabilities and hidden-folder data use `localDirectory`.
- Document listing, ordinary document reads/writes, editor matching, reveal and document synchronization use `contentDirectory`.
- Engine context is resolved to the project ID using `localDirectory`; content lookup then uses that ID's registered content directory.
- Existing application file references beginning `.opencode/` or `.legalwork/` resolve against `localDirectory`. Ordinary document-relative references resolve against `contentDirectory`. The resolver validates the selected root and relative path with no arbitrary fallback to another root.
- Native engine file tools retain standard OpenCode path resolution: relative paths start at the local engine/project home. The agent receives both directory locations and uses explicit absolute host paths for connected documents and document searches. File-tool arguments, patch headers and search defaults are not rewritten. Existing external-directory and read/edit permissions govern access to connected folders.
- Existing shell instructions or skill helpers that assume `.opencode` is under the document working directory must use the resolved local capability path instead.

### What already exists and what is new

Verified in source revision `65e42ac5b`:

- Settings > Permissions already adds and removes additional folders for the selected project through GET/PUT `/workspace/:id/authorized-folders`.
- Explicit project folder grants are native `external_directory` permission rules, stored in project runtime configuration in `runtime.sqlite`. They are paths and policies, not symlinks or copies. Read/edit/shell and firm rules still apply separately.
- Allow for this chat persists access on the verified parent chat and its subtasks; it does not add the folder to other chats or the project's shared folder list. Legacy project-wide approvals are preserved until revoked.
- Native file tools use actual host paths and engine/project permission checks. They do not all pass through the protected filesystem bridge.
- `legalwork_shell` already chooses host execution when sandboxing is off, or protected VM execution when on. The default sandbox setting is off, subject to saved preferences and firm policy.
- Protected commands already expose the primary workspace at `/workspace`, authorized extra folders at `/authorized/<n>`, and selected skill resources at `/skills/<n>`.
- The existing QEMU guest FUSE adapter sends file operations to the host's `SandboxFilesystem` broker. It reads original files lazily and stages writes with conflict checks before committing. There is no full-folder copy at startup.

Still new: relocating the two trees, persisting independent local and content roots, updating native session locations/history associations, selecting the primary document root for UI and shell work, and connecting those new roles to existing permissions and mounts. None of that end-to-end storage migration is implemented by the existing additional-folder feature.

### Recommended minimal connection wiring, pending agreement

Reuse existing workspace and authorized-folder roles with the local project home as the engine's primary workspace:

```text
/workspace                         -> local project home containing .opencode and .legalwork
/authorized/0                      -> former document folder, as an authorized content folder
/authorized/1                      -> an existing additional folder, if any
/skills/<n>                        -> selected skill resources using current policy
```

This is a smaller candidate than the earlier illustration that kept the content folder at `/workspace` and added special local artifact mounts. It preserves the current meaning of the engine's workspace. The numbers depend on the command's actual grants; they are not stable file identities. Document-focused commands can set their working directory to the authorized content folder using the already supported `workdir` argument. The UI should continue to browse the primary content directory. Native file tools use the real host paths.

The local home exposes the same hidden-folder contents that the primary workspace exposes today; this change does not silently add a new filename-based protection model. Existing permissions continue to apply. Do not authorize the parent LegalWork data directory, another project's home or shared private runtime. If selective artifact-only exposure is wanted later, that is a separate sandbox policy change rather than a requirement for relocating the two folders.

With sandboxing off, there are no `/workspace` or `/authorized` guest mappings: commands run on the host and use absolute host paths. Directory grants are still used by managed file tools, but unrestricted host commands are not confined to those grants by an OS filesystem boundary. The migration must work with both execution modes and must not silently enable or disable sandboxing.

When sandboxing is on, the existing bridge reads content lazily from the original folder. Protected writes are staged and committed to the original source after checks, including detection of concurrent source changes. No complete folder copy is created.

The project's explicit folder grant makes that location available to managed tools, while effective read/edit, shell, firm, agent and session restrictions continue to apply. The current additional-folder UI is a location grant; it does not itself provide a separate per-folder read/write selector. OS filesystem permissions and network-share authentication still apply. Revoking the connection removes the derived native grant and future mounts, and must invalidate affected active access under the existing permission-change machinery.

If the connected drive is offline, engine startup, chat history and local attachment access must remain available. Operations requiring the external folder fail with its disconnected status. Do not recreate that path as an empty project, remap `/workspace` silently to another folder, or save external edits somewhere else without an explicit operation.

Provider-connected cloud folders retain their current provider references and scoped permissions; they are not forced into this OS-path model. The current read-only scoped links remain read-only.

## 4. Migration procedure

1. Inventory the project's two directory trees and all registered project IDs, native session locations and stored references. Record old content root to new local root mappings.
2. Pause affected agent work, schedules, sync and reload watchers. Wait for writes to settle; back up registries and take consistent snapshots of authoritative databases before altering their records. Run the existing OpenCode history upgrade against the original project paths and wait for its completed status. If that upgrade fails, leave the hidden folders and registered project paths in place.
3. Stop the upgraded bootstrap engine, then copy `.opencode` and `.legalwork` into a private staging project home without changing their internal layout. Verify hashes and completeness. Cross-volume migration must not assume a rename is atomic.
4. Update the project's root mapping, generated absolute paths and native session locations. Preserve chat IDs, parent/child relationships, provenance, permissions, recovery/undo associations and scheduled work. Use a verified supported engine migration mechanism; the existing native move test is evidence of move capability, not an already implemented bulk migration.
5. Publish a journaled per-project cutover across server/desktop registries and relevant session associations. On interruption, complete or roll back that recorded generation rather than combining old and new authoritative state.
6. Reopen existing chats, attachments, reviews and connected documents. Verify sync sees the same project and content. Resume work only after verification. Keep original support data as recovery material until verified cleanup; do not leave both locations active for normal writes.

A missing source remains pending. A conflicting destination must not be overwritten or merged blindly. Existing application-relative attachment paths can retain their suffixes through the root resolver. Historical absolute references need a verified compatibility mapping; do not replace arbitrary path strings throughout immutable transcripts.

The engine binary, process-global working directory, shared database locations and existing external browser staging are unchanged by this migration. Do not use this change to add a general profile relocation feature.

## 5. Required code changes

The [source inventory](project-storage-reference-inventory.md) remains an audit index for source revision `65e42ac5b`. It contains direct literals and indirect consumers, not 135 mandatory rewrites. Many hidden-folder path constructors can remain unchanged once their callers pass the local project home.

| Area | Required change |
| --- | --- |
| Platform paths and registry | Add one local project-home resolver and persist local/content roots in the server workspace contract and desktop store. Change only the default project creation destination for new projects. |
| Creation and initialization | Create/initialize the local home, and register or create the content directory separately. Do not create `.opencode` or `.legalwork` in the connected folder after migration. |
| Native engine configuration | Use the local home for generated project settings, capability discovery, admission registry and managed settings. Remove managed lifecycle assignments that force the engine directory back to the content path. |
| Engine/session ownership | Use the local root for chat location, project resolution, history search, recovery and provenance; preserve existing IDs and migrate saved directory associations. |
| Hidden-folder stores | Pass the local root to reviews, preparation, search history, metadata, attachments, drafts, audit and inbox/outbox. Keep their relative directory layouts unchanged. |
| Content file APIs and sync | Use the content root for ordinary document IO, project file browsing, document sync and source file references. Preserve prior exclusions for dotfolders, source providers and cloud-folder policies. Review sync still finds its unchanged relative path under the local root. |
| Permission and shell bridges | Reuse authorized external-directory access for the content folder and the ordinary local project workspace for hidden-folder files; map each against the project's authoritative roots. Keep global private storage protected and reuse existing virtual mount names. |
| Agent tool and frontend adapters | Resolve engine context through the local root, display content locations to users, and route old hidden-folder references locally. Update capability resource paths, file cards, editors and Office matching where they currently assume one root. |
| Import/export, reload and lifecycle | Watch/import/export the right roots; do not treat disconnection or migration cleanup as document deletion. Reset/clear-cache must preserve durable local project data. |
| Documentation and checks | Update help and generated instructions to describe local support data plus connected content. Adapt existing path and released-engine tests; perform real desktop acceptance on macOS and Windows. |

## First proof and acceptance

Before bulk migration, prove the pinned engine can run a project whose native location is a local directory containing intact `.opencode` and `.legalwork`, while content remains on another volume. Read/edit one connected document, read a migrated attachment, reopen an old chat, and disconnect the content share while retaining access to the local chat and attachment.

Cover interrupted/resumed migration, read-only/offline sources, destination collisions, Windows UNC/mapped aliases and Unicode/case behavior, authored configuration and skill resource paths, pending/suspended/subagent work, old attachment/file cards, review/source path associations, sync exclusions, Office document matching and reset/cleanup preservation. Implementation and verification results, including outstanding platform acceptance, are recorded in the implementation plan.


## Follow-up contract: discovery, recovery and wikis

Wiki workspaces participate in the same post-OpenCode-history relocation. Keep wiki IDs, workspace IDs, chat IDs, sharing bindings and wiki.root. Move only the two support trees to Projects/<existing-workspace-id>; workspace.contentPath remains wiki.root. New default wikis allocate a stable workspace ID first and use its home/files directory. Create, join, restore and registry recovery use this same mapping. Shared wiki registration, indexes/history and sync stores keep their existing locations. Content unavailability does not make a wiki's local engine home unavailable.

Wiki privacy, own-wiki classification, approvals and native/sandbox guards resolve engine identity through the authenticated registered workspace. Content APIs, project-file grants and read-only project mounts use document roots; private support homes are protected separately. The UI creates wiki chats at the engine location and continues opening authored assets at wiki.root.

Primary content-folder AGENTS.md is an explicit native instruction source. The custom reminder hook for nested external AGENTS.md was removed at the user's request; native file-tool discovery applies, and external nested instruction files can be read explicitly. Visible Skills/, .claude/skills and .agents/skills remain in content and join the local .opencode skill library. Secondary connected folders keep their existing discovery semantics.

Authored primary-root opencode.json/jsonc stay in content. Owned local native snapshots retain their original precedence below .opencode; known relative file/plugin/instruction/skill references retain their original base. Their private content-addressed cache and ownership journal permit interrupted publication to finish without contacting the source. Post-startup content watchers refresh changes; cached configuration does not require the connected drive during engine startup. Arbitrary parent configuration ancestry is not newly imported. Native global discovery remains unchanged.

Migration receipts distinguish a prepared copy, a durably published registry mapping and completed native session relocation. Revalidate unpublished source/copy fingerprints; keep divergent versions rather than selecting stale data. Recovery consults the saved original content association before assuming home/files. Offline synced document state is unknown, not zero changes: count local support/database work separately and hold automatic or ordinary no-force removal.

Browser ownership uses registered engine identity separately from document download destinations. Local and transferred browser downloads publish to content Downloads/. Email draft artifacts remain under local .legalwork while each attachment resolves against its document/support source. Existing native relative path resolution remains unchanged.
