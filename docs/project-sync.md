# Project sync (Eigenwelt Sync for Akten)

[EIG-208](https://linear.app/eigenweltlabs/issue/EIG-208). Platform side: `model-api`, branch `claude/project-sync` (`docs/project-sync.md` there).

## What users see

A project stays on its owner's computer until they choose **Share** next to the project name on Home. Sharing works like sharing a document in Google Drive or Notion: it is simply who has access.

- **Add people** at the top of the dialog: colleagues one by one, or **Everyone in your firm** (including anyone who joins later). Each shows in the list with its own ✕, the firm too. Admins get no automatic access.
- **What is shared**: a one-line summary (documents and folders, Tabular Reviews with their documents, notes, tasks, calendars, recordings, project details) that opens to switches. Anything left out stays on each computer. With Tabular Reviews on and documents off, exactly the documents the reviews review are shared.

There is no separate "stop sharing": when the owner removes the last person (and the firm) and saves, the dialog says the project will no longer be shared, and it goes back to being only on this computer.

Chats never sync with a project; a chat is shared on its own, through its own sharing.

Colleagues with access get the project on their computers without doing anything: a folder in their projects folder, the documents, notes, details and tasks. They can edit everything; only the owner changes access and scope. A colleague can leave a project; it is removed from their computer and the firm keeps it.

Once shared, the button reads **Shared** with the faces of the others who have it (or the firm icon), and the sidebar row a quiet people mark. Syncing itself stays out of sight: only offline, sync problem, folder missing, paused or access ended replace it with a warning. Home shows a banner for anything that needs a decision. A colleague sees the same dialog read-only and can **Leave project**, which removes it from their computer.

## How it works

| Part | Where | How |
| --- | --- | --- |
| Identity | `project_links` in runtime.sqlite, and `syncProjectId` in `.legalwork/project.json` | A synced project gets a firm id. The id in the folder lets a pulled project be recognised in an existing folder (interrupted arrival, reinstall, folder added again) instead of becoming a second Akte. The owner's own folder is taken up again silently. A member's own project whose folder carries the id (the same folder on a shared drive) is not: `project_offers` records the question, nothing arrives and nothing is sent until the member chooses **Use this folder** or **Keep apart** (the shared project then gets a folder of its own). |
| Name, details, personalization | Project record on the platform | Local edits are queued (`project_outbox`) and pushed with their time. The platform keeps the newest edit per detail, including the project's writing instructions, so two colleagues editing different details both keep theirs. Personalization follows the Project details (`metadata`) switch. Clearing instructions syncs an empty prompt and restores global writing defaults on each computer. |
| Documents, notes, recordings | The project folder, compared three ways | `project-file-sync.ts` compares the folder, the firm's copy and what both last agreed on (`project_file_base`). Talks to the firm through the `StorageAdapter` interface (`eigenwelt-project-storage.ts`). The bytes move in 8 MiB chunks straight between this computer and the firm's storage over links the platform signs (`eigenwelt-projects.ts`); this computer checks the hash of what it uploads and downloads. |
| Tabular Reviews | `.opencode/legalwork/reviews/` in the folder; at the firm under `.legalwork/reviews/` | Their own switch, `reviews` (`project-review-sync.ts`): each review and each earlier run's snapshot (`history/`), compared three ways like documents, with what was last agreed kept in `project_review_base`. Moved as whole files over the same signed links, before the documents: each review tells the firm which documents it reviews, and with documents off, those are the documents that sync (here, and at the firm, which refuses the others). |
| Tasks | Task store and task sync | A task syncs if it has no project, or its project syncs tasks. A task in a local project writes nothing to the outbox. |
| Recordings | Recorder, then the project folder | Finished recordings linked to the project are copied once into `recordings/` (audio and transcripts, never `meta.json`) and sync as files. |

Rounds start a few seconds after changes in a synced folder and after local edits, and at once when the firm pokes this computer (`eigenwelt-sync-events.ts`): while signed in, it keeps one server-sent event stream open to the platform (`GET /api/sync/events`). A poke says only that the firm's projects or tasks changed; the round pulls what changed, through the routes that check access. The first poke on every connection is a resync, so nothing missed while disconnected is lost; the stream ends before its token does and connects again with a fresh one. While pokes come, the minute timer only steps in every five minutes; without them, it runs every minute as before. Task sync keeps its own rounds; pokes start them too.

A round does not list a project's documents whole each time: this computer keeps the firm's listing (`project_remote_files`) with the number of its last change, and asks only what changed since (`GET …/files?since=`). It lists whole once after each start, when the platform says what the project carries changed, and whenever a write finds the firm's copy other than the kept listing said.

The app hears the same way from its own server (`app-sync-events.ts`, `GET /sync/events`): every window keeps one server-sent event stream open, and an event says that projects or tasks changed on this computer (a round brought or sent something, a reminder came due, another window or an agent changed a task). The window then re-reads what it shows: sync states, a project whose files a round changed, the tasks, and the task notifications. The first event of every connection is a resync, so the window re-reads everything after a dropped connection. While the stream is open nothing is polled; without it (still connecting, or a server without the stream) the app asks every five seconds for sync states and every 30 seconds for tasks, as before (`kernel/sync-events.ts`).

### Documents: what happens when

- Changed here or remotely only: goes to the other side. Every upload and remote delete names the version it replaces; the platform refuses a stale one.
- Deleted remotely: moved to `.legalwork/sync-trash/<time>/` (kept 30 days).
- Deleted on one side, edited on the other: the edit wins and comes back.
- Edited differently on both sides: text a person writes (notes, `.md` and `.txt`) is merged as Git merges, by lines and, where both changed the same lines (a paragraph is one line), by words (`text-merge.ts`); sync keeps the text both sides last agreed on as the base (`project_file_base_text`). Only where both changed the same words, and for every other kind of file (Word, PDF), the firm's version keeps the name and this computer's version is kept next to it as `Name (Member, 2026-09-25 14.03).ext`, which syncs too. Home asks which version stays, with both a click away: **Keep both**, **Use theirs** (the copy goes) or **Keep mine** (it replaces theirs for everyone, and the copy goes); a removed copy goes to the sync trash, and its removal reaches everyone. A conflict is no state of the project: the Share button and the sidebar do not show it.
- Open in the editor while it changed (a colleague's edit synced in): unsaved typing is never replaced. Saving sends the text as loaded, and the file is merged the same way; the editor shows the merged text and says so. Changed in the same place: the editor asks, **Keep both** (yours as a copy beside it), **Use the other version** or **Keep mine**.
- More than 10 deletions (and half the files) at once here: held back until the user chooses **Delete for everyone** or **Bring them back**.
- Folder missing: sync pauses for that project; nothing is deleted.
- Not synced: hidden files and folders (`.legalwork`, `.opencode`, `.git`), Office lock files, temporary downloads, files over 256 MB, names another system cannot store. The last two are listed in the dialog.

### Tabular Reviews: what happens when

- Shared without documents: a document a review reviews syncs; the others stay on each computer. A document no review reviews any more leaves the firm (it stays on the computers that have it). Turning reviews off takes them, and the documents they brought, off the firm.
- Projects shared before the switch existed, and older LegalWork versions, share no reviews until the owner turns them on.
- A review changed on both computers is merged, not copied: name, settings, each column, each document and each answer cell separately. Where both changed the same part, the newer change wins; for an answer cell, the answer given later. An answer to a question changed meanwhile is marked out of date, as after an edit.
- An earlier run's snapshot is replaced whole; the later one stands.
- Deleted on one computer: removed on the others (into `.legalwork/sync-trash/`), unless it was changed there meanwhile.
- Stays on each computer: the chat a review was started from (chats are never shared), where its prepared documents are cached, its revision counter. A colleague opening a source prepares the document on their own computer.
- A review running on one computer is uploaded with a mark naming who runs it, renewed every round. Others see "Running on Anna's computer" and the progress, and cannot run, change, stop or delete it. Without a sign of life for 10 minutes the run counts as interrupted. The running computer takes changes from the firm once its run has ended; until then the others see its progress merged with their changes.
- A missing review folder brings the firm's reviews back rather than deleting them for everyone.

### Project personalization

Project personalization uses the project API rather than syncing the hidden `.legalwork/project.json` file. Initial sharing includes the saved prompt; later user or approved agent changes enter the same durable outbox. Unsent instructions stay intact when another computer's prompt arrives. Turning Project details off removes instructions from the service and leaves each computer's saved prompt alone; turning it on publishes the owner's current prompt. Existing shared projects with previously local instructions publish them once the upgraded service advertises an uninitialized prompt. Older services cannot acknowledge instruction writes: the outbox retains them and reports that the service needs an update.

### Tasks

- Two people changing one task: each field on its own, the later change wins (status, due date, assignee, priority, tags); notes are only ever added. Title and description are merged like notes: an edit says what it started from, and a colleague's change meanwhile is merged with it on the platform. Where both changed the same words, the colleague's text stays, and the one whose change came second is asked, in a notification and on the task: **Keep both** (theirs stays, and yours is kept in the task's history), **Use theirs** or **Keep mine**.
- Pokes start task rounds too: a colleague's task change arrives within a few seconds.
- Moving a firm task into a local project: only its creator can, and it is withdrawn from the firm (its content leaves the platform, other computers forget it). Inbox tasks and colleagues' tasks cannot move into a local project.
- Moving a local task into a synced project, or turning on sync or tasks: it is sent whole (task, notes, files).
- Turning tasks off, or stopping sync: the owner's computer keeps them as local tasks; the platform withdraws its copies. Inbox tasks go back to the firm's task list.
- A task in a synced project waits until the project itself reached the firm.

### Access ending, stopping, signing out

- Owner stops syncing: the project stays on the owner's computer as a local project. The platform drops its documents and tasks; colleagues' copies are removed. Shared again from the same project, it is the same project at the firm (this computer remembers its id, `project_stopped`, and the platform revives it for its owner): a copy held back takes it up again, and colleagues whose copy was removed get it back under its name, not as a second project.
- A member loses access: their copy is removed. If changes made there had not reached the firm, it is held instead and Home asks: **Keep it as my own project** or **Remove it**. Given access again, it syncs again. What both sides last agreed on is forgotten then (the firm's copy may have been dropped meanwhile), so nothing missing at the firm is taken as deleted there: the two are merged, and files that differ are kept both.
- A folder the member brought themselves (used as their copy) is never deleted: losing access or leaving turns it back into their own local project, and the owner's id in it is left alone. Only folders sync created are removed.
- Sign-out: copies that came from the firm are removed (the sign-out stops first if they hold unsent changes). The member's own synced projects stay and resume after signing in to the same firm.

## Checks

```sh
pnpm --filter legalwork-server typecheck
cd apps/server && bun test src
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app test
pnpm --filter @legalwork/app test:i18n
pnpm --filter @legalwork/desktop test
```

`project-file-sync.test.ts` covers the comparison rules and path safety. `project-review-sync.test.ts` covers reviews between two computers: what stays local, merging answers and columns, out-of-date answers, deletion into the trash, a run watched elsewhere and merged when it ends, and a missing folder. `eigenwelt-projects.test.ts` covers the transfer over signed links: only missing chunks go up, no credentials go to storage, a file changed during upload is not committed, and downloads are joined from their chunks. `project-sync.test.ts` runs several computers against one in-memory platform: sharing, edits both ways, details per field, conflicts, losing access with and without unsent changes, stopping, resuming after a reinstall without a second copy, the same folder already being the member's own project (asked, kept apart, or used and kept on leaving), recordings, and tasks of local projects staying local.

End to end, two LegalWork servers (owner and member, each with the web UI) ran against the real platform routes on the integration Postgres, with Clerk stubbed. Verified: sharing from the dialog, the member's computer receiving the project with its documents, details and task, an edit and a detail going back, a conflict kept as two files with the banner, the member's read-only settings, removing the member (copy removed), and stopping sync.

## Limits

- Every synced project a member can see is on their computer; there is no on-demand download yet.
- Empty folders are not synced; folders exist through the files in them.
- Recordings arrive on other computers as files in `recordings/`, not in the Recordings section.
- In the browser-only web UI, a project removed by sync stays in the sidebar until reload; the desktop app reloads its list.
- Nobody can take over a project whose owner left the firm yet.

## Calendars

Calendar sharing defaults to enabled. Calendars use the existing project access rules and subscription connection, with their own whole-record revision sync. Dated task projections additionally respect task sharing. See [Project calendars and deadline skills](project-calendars.md) for the APIs, calculation coverage, conflicts, reminders and rollout requirements.
