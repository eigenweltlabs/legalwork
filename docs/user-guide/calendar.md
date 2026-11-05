# Calendar and deadlines

Open in LegalWork: [Calendar](legalwork://app/calendar).

Use Calendar to see when work is due and keep deadline records with their supporting context. It is separate from a Google Calendar connector and from [Scheduled tasks](scheduled-tasks.md), which start assistant runs.

## Find and read the calendar

Open **Calendar** in the main navigation for the combined view, or a project's **Calendar** for that project's entries. The combined view includes accessible local/shared projects and dated Inbox tasks. It does not automatically import every appointment from your Google or Outlook account.

Choose **Week**, **Month** or **Agenda**. Week is the initial view. Move between dates or return to today, and use the filters to narrow the displayed work. Opening a task opens its normal task detail without turning it into a separate deadline. A task without a date will not appear as a dated entry. Project Home also shows upcoming active deadlines and a **View all** action.

## Add a deadline

1. Open the intended project's Calendar and choose the new-deadline action. In the combined calendar, choose the project in the dialog.
2. Enter a clear title, the confirmed due date and useful context. Set the assignee and reminders where needed. Check the time zone and any existing time-of-day information.
3. Attach the source document by selecting a project file, uploading it or dropping it into the dialog. Link a relevant project chat if useful.
4. Save, then open the entry again to check the date, project, attachments and reminder settings.

The manual date entry is available without a calculation skill. **Entered manually** describes how a date was recorded; it is not a legal verification. Editing an imported or recurring entry preserves advanced properties that the simple dialog does not expose. Do not assume a date edit has rewritten an entire recurring series.

## Ask the assistant to calculate a deadline

Provide the jurisdiction/procedure, the triggering event and its date, the relevant source and any court or filing-time details. Ask the assistant to use an installed deadline skill, record its calculation and attach the source. For example: "Use the supported deadline skill to calculate this deadline from the attached service record. Ask for any missing facts and show the calculation before I review it."

The supported German civil, England and Wales civil, and US federal civil skills cover specific scenarios. They can refuse missing facts or unsupported rules. The calendar must not replace a refused calculation with a guessed date. A saved calculation retains its inputs, rule version, source links and reasoning trace.

Calculated and imported dates can show **Needs review**. Inspect the source and calculation, then use the explicit review confirmation when satisfied. Changing the date or source clears that confirmation. Overriding a calculated date requires a reason and retains the original calculation in history. Completing a linked task does not complete the legal deadline; update the deadline's own status deliberately.

## Reminders, history and conflicts

Reminders notify you; they do not file a document or execute a workflow. Local reminders can work offline while the runtime is running. Shared reminder delivery depends on the firm's service; desktop notifications arrive while the desktop is running or after it reconnects. This calendar does not promise reminder emails or mobile push notifications. Check OS notification permissions as well as the entry's reminders.

Open the entry's history to inspect revisions. If two computers edit the same record, resolve the reported conflict rather than assuming the last date you typed replaced the other version. Deleted entries have restore controls. Removing an attachment from an entry removes its link, not the source project file.

## Share or subscribe

Project **Share** controls who can access its calendar. Dated task entries also depend on sharing the project's tasks. Documents attached to calendar entries can be shared with the calendar even when general document sharing is off, so review those attachments before sharing.

With a supported active subscription, **Subscribe** creates a read-only calendar URL. A project calendar has its own link; the combined calendar has a separate combined link. Copy it into the calendar application's URL-subscription feature. That app chooses when to refresh, so changes may not appear immediately. Treat the link as an access credential and use **Disable link** in the subscription dialog to revoke it.

Private local entries included in a subscription are copied to the service and refreshed while LegalWork runs. The latest synced copy remains available when the computer is closed. The subscription is one-way viewing, not two-way editing, meeting-invitation delivery or a CalDAV account. ICS import/export exists in the backend but is not a Calendar UI button in the inspected implementation.

Related: [Tasks](tasks-intake.md), [Projects and sharing](projects-sharing.md), [Screen map](screens.md).
