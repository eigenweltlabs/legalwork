# Wikis

A wiki is a local folder of Markdown pages, properties, links and supporting files. Open **Wiki** in the navigation to create, join or manage one. Each wiki restores its own chats, tabs and layout. Projects can open wiki pages beside chat through **+ → Wiki page…**; those pages are read-only and link back to their wiki workspace.

## Setup and content

**New Wiki → Law firm** creates Clients, Matters, Knowledge, Processes, Templates, Firm, Sources, Dashboards and Reports. It seeds root `AGENTS.md`, `Structure.md`, regional guidance in Knowledge and Templates, and four editable workflows in `Skills/wiki-{setup,capture,use,maintain}/SKILL.md`. Blank and existing wikis retain their own conventions. Page types, properties and folder organization are editable.

Open a wiki chat and ask **Help me set up this wiki for our firm.** Naming a connected source authorizes processing that scope; otherwise setup establishes structure without importing records. Connected documents are read through storage tools without opening viewers. Keep useful entity facts, substantive findings and non-obvious processes in pages. Progress, failures, connection IDs and machine-generated provenance belong outside the visible knowledge. Source descriptions should identify the document, date and relevant section. Only reusable templates may be copied by the setup workflow; direct client source documents remain in their original storage.

## Pages and navigation

Pages support block editing, inline `[[Page.md]]` and relative file links, properties below the title, Source mode, an outline and computed backlinks. Links in properties also connect the graph. Source mode preserves literal Markdown; rich-text edits may normalize formatting. Page contents do not execute arbitrary scripts.

Use the file tree to create, move, rename or delete files and folders. User-initiated imports copy files into the selected folder; the source remains intact. Office documents, PDFs and media use the existing viewers. History and Trash restore local saved versions without replacing an existing file. Renaming or moving a file updates open tabs but does not rewrite authored links.

## Dashboards and reports

Agents use `view_catalog`, `view_create` and `view_update` with the bundled OpenUI components. Partial generation opens a preview beside chat. Live dashboards query indexed wiki properties; reports save frozen datasets and source ownership. Both are ordinary `.view.json` files. Project reports are available through Files and remain in their project.

Embed a saved view with a `legalwork-view` code fence containing its UUID. The same record opens in a full tab. Writable dashboard boards can update source properties with revision checks; report snapshots and streaming previews are read-only. The retired YAML view configuration is no longer interpreted.

## Agents inside and outside a wiki

An agent working in a wiki folder can edit that wiki within the user's task and permissions. Project agents read only the wikis made available to their project. Tools resolve the authenticated session origin on every call; wiki Markdown cannot expand permissions.

- `wiki_list` discovers available wikis; `wiki_guidance` reads their actual folders, root instructions and inherited regional guidance.
- `wiki_search` searches full indexed text and metadata across accessible wikis with ranked passages, phrases, prefix matching and pagination.
- `wiki_read`, `wiki_fields` and `wiki_query` retrieve pages, field definitions and structured data.
- Direct page, property and view mutations remain restricted to the wiki's own workspace.

Wiki suggestions are user-triggered. For a broad contribution request, the project agent first inspects relevant project work, checks candidate wikis and existing subjects, then explains the specific useful contribution and destination. Prefer focused updates to existing entities over thin new pages, generic checklists or execution logs.

`wiki_suggest` stages an editable Markdown file under the originating project's `.legalwork/tmp/wiki-suggestions/<id>/draft.md`. It opens beside chat with properties and a wiki/folder picker. Switching wikis resets folder selection. Requested agent edits modify only this draft. **Save to wiki** rechecks access, destination and revisions, publishes the reviewed content and replaces the draft in the same tab. **Dismiss** records the decision without changing the wiki. Agents cannot invoke either action; conflicting edits retain the user's draft for comparison.

## Weekly knowledge review

Scheduled tasks offers a weekly wiki review starter. The user chooses a project and adds it explicitly. It reads the previous seven days of accessible project chats, checks the target wikis' guidance and existing knowledge, and stages worthwhile contributions in that chosen project's temporary folder. It skips prior automated reviews, duplicates and rejected ideas. It publishes nothing and produces no drafts if there is no useful addition. The user reviews, saves or dismisses suggestions in that project.

## Sharing and recovery

Wiki settings can share with the whole firm or selected members. Only the owner changes the audience or stops sharing. Members join into a local folder without reseeding starter pages. The firm API must support independent wiki sharing; otherwise the wiki stays local and reports the required update.

Saved files sync with revision checks. Independent text changes can merge; overlapping edits preserve a conflict copy. Access is rechecked before publication. Sign-out, changing firms or revocation stops shared access. Stopping sharing retains the local folder. Older connector-based registrations require explicit migration before uploading.

Local History and Trash are not shared audit storage. Restoring a file creates a new saved revision. Back up the server state directory as well as the wiki folder if registrations and local history must survive a machine replacement.

## Implementation and limits

Markdown and frontmatter are canonical. The server keeps an incremental SQLite index, full-text search and local history. Pages are limited to 2 MB and attachments to 100 MB. Hidden files and symlinks are excluded. Supporting files sync eagerly; empty folders and local history remain local.

The graph uses a compact projection, a worker layout for smaller graphs and GPU simulation above 5,000 nodes where supported, with Canvas recovery. Positions and camera state persist locally. Sandbox and filesystem policies apply independently of wiki content guidance.

## Verification

Run app and server type checks and test suites, plus `bun test packages/openui/src`. The synthetic fixture and reproducible example prompts are described in [wiki-demo-flows.md](wiki-demo-flows.md). Real shared-wiki tests require the companion firm API and their configured test environment.

## Project contributions and approval

`WikiRegistration.requireAgentApproval` defaults to true except for the automatically generated research wiki, which defaults to false. Existing default research wikis adopt false only when the field is absent; explicit choices survive upgrades. The owner changes it under Settings > Agent access. External project agents always use the contribution routes; direct page writes/deletes remain blocked. With approval disabled, authenticated agent POST/PUT contributions publish through `WikiStore.writeContribution`, with fresh access checks, immutable staged bytes and exact page revisions. The store serializes the setting change with publication. Human draft edits remain pending and the Save/Dismiss routes remain human-only. Background results return `status: saved` and do not open review tabs.

Published source attachments use `Sources/<filename>` directly, reuse identical bytes and choose numbered filenames for collisions. Portable links are regenerated against the final paths. The normal viewer opens immutable draft sources in separate read-only tabs via the revision-checked attachment API. Source sections use ordinary Markdown. Rich editing suppresses only the legacy internal source markers, preserving their links.
