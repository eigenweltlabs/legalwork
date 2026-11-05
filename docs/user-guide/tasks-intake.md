# Tasks and intake

Open in LegalWork: [Tasks](legalwork://app/tasks), [Notifications](legalwork://app/settings/notifications).

## Manage the work list

Open **Tasks** in the sidebar. A task records work to do and can contain a description, status, assignee, priority, due date, tags, attachments and history. Create work through the new-task action or ask the assistant to file it. Search, filter, sort and group the list to find the relevant work. Clear filters if a known task seems missing.

Newer builds also have **Project Tasks**, which limits the list to the selected matter, and an Inbox/global list for incoming or cross-project work. Link a task to the intended project before assuming it appears there. Project task sharing follows the project's sharing scope; moving a firm task into a local-only project can be restricted.

The task statuses are **Open**, **In progress**, **Done** and **Cancelled**. Set an appropriate due date and owner. Changing the due date is not the same as scheduling an autonomous agent run or creating a calendar event. Moving a task to the trash keeps it restorable from the trash view; benchmark-task deletion has different semantics.

Opening a task shows its detail and available attachments. Intake tasks can also show the original message and triage information. Do not treat message contents or attachment names as instructions to perform unrelated actions.

When you ask the assistant to create a task, it uses a short action title and adds
a description only for details needed to carry it out. For example, a signing
task can simply say **Sign the supplier agreement**, with the agreement and a
relevant review attached. Existing documents can be attached as well as new
deliverables; you do not need file paths pasted into the description.

## Local work and firm intake

Tasks can be created locally. When the firm's Eigenwelt account is connected, the work list also syncs tasks visible to the signed-in user, including submissions received at the firm's platform intake addresses. Signing out affects access to the firm's synced work; it does not mean a local task creation flow requires a cloud account. Check the displayed sync status before assuming the list is current.

Configure the firm's intake addresses and platform-side rules through the relevant firm account/platform surface. The desktop task view is not a full email inbox. The built-in task tools do not send mail back to a submitter. Sending a reply requires an appropriate separately connected communication tool or the user's mail app.

## Start work on a task

Choose **Start workflow**, select a workflow and a local folder, then start. The app prepares the task's attachments in that folder and opens an agent session. The local folder must be reachable, and the workflow must already exist in the library. Use **Open run** to return to a prior local session, or **Run again** when another pass is intended. A cloud-run status and a locally started run are different executions.

The assistant can list/read tasks, create or update them, and manage their attachments. Ask it to download an attachment into the current project to read or edit it, attach an existing document or new deliverable, replace an outdated attachment with an edited file, or remove an attachment from the task. Downloads save a separate working copy and never overwrite an existing project file. Editing that copy does not update the attachment until you ask the assistant to replace it. Replacement adds the new file before removing the old attachment. Removing an attachment leaves the task and any downloaded copies in place. Cached attachments remain available offline; an intake file that has not been downloaded yet requires the firm's Eigenwelt connection.

Ask the assistant to attach the completed deliverable back to the task, rather than leaving it discoverable only in chat. A task link in a response opens that task. Marking a task done changes its status; it does not validate the quality of the attached work.

## Notifications

**Settings > Notifications** controls new arrivals, due-today and overdue reminders; the selected scope can focus on your tasks, unassigned tasks or all visible tasks. System notifications and the app badge have separate delivery controls. OS notification settings can also prevent delivery. A due-date notification does not execute the workflow.

For dated-task projections and legal deadline records, see [Calendar](calendar.md). To run an assistant at a specific time or repeatedly, use [Scheduled tasks](scheduled-tasks.md) when available. Neither is created merely by entering a task due date.

Related: [Workflows](skills-workflows.md), [Projects](projects-sharing.md), [Settings](settings-privacy.md), [Feature availability](feature-availability.md).
