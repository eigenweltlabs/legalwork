# Calendar and deadlines

Open in LegalWork: [Calendar](legalwork://app/calendar).

Use Calendar to see when work is due and keep deadline records with their supporting context. Connected Google and Outlook calendars can appear alongside project work. [Scheduled tasks](scheduled-tasks.md) start assistant runs separately.

## Find and read the calendar

Open **Calendar** in the main navigation for the combined view, or a project's **Calendar** for that project's entries. The combined view includes accessible local/shared projects and dated Inbox tasks. Use **Connected calendars** to show or hide calendars from your connected Google and Outlook accounts. To connect an account, open **Add > Plugins**, select **Google Calendar** or **Outlook Calendar**, and complete the connection.

Choose **Day**, **Week**, **Month** or **Agenda**. Week is the initial view. Scroll horizontally in Week to move continuously into earlier or later weeks. The arrow buttons and **Today** remain available. Move between dates or return to today, and use the filters to narrow the displayed work. Opening a task opens its normal task detail without turning it into a separate deadline. A task without a date will not appear as a dated entry. Project Home also shows upcoming active deadlines and a **View all** action.

Loaded date ranges stay cached in memory for the app session without a time limit, so reopening Calendar or revisiting a loaded week displays events immediately. A successful refresh or sync replaces the cached data. Events refresh in the background every minute while Calendar is open. **Refresh** checks for changes immediately. A refresh failure leaves previously loaded events visible and shows an alert. Closing the app, signing out or changing the connected account clears its cache.

Open a connected event to read its full description, dates and times, time zone, location, organizer, attendees and responses, recurrence and reminders when provided. Meeting links, description links and supplied attachment links are clickable. Outlook attachments that are only identified as present can be viewed with **Open in Outlook Calendar**. The preview groups the schedule, location, organizer, reminders and files alongside the description. **Repeats** shows the interval, selected weekdays and end condition when the source supplies the rule. For rules not supplied with an occurrence, use the source calendar to inspect the full schedule. Choose **Show all** to expand a long attendee list. The preview scrolls to keep every detail accessible. Personal calendar events remain associated with their connected account and calendar.

From an [email invitation](email.md#meeting-invitations), select **Calendar** to open this view at the invitation date. Connected calendar overlays use their existing Integrations accounts and visibility settings. This opens a date without importing the attachment or changing an event.

Email's **Reply** action can review and submit an invitation response through these same Google Calendar or Outlook Calendar integrations. The review names the selected calendar and invited participant, including a delegated participant when permitted. See [meeting invitation replies](email.md#meeting-invitations) for the steps and recurrence limits.

## Shared Outlook calendars

1. Accept the owner's calendar sharing invitation or add their shared calendar in Outlook. The owner must grant the access you need. Replying on their behalf can require delegate permissions beyond permission to edit events. See [Microsoft's sharing and delegation guide](https://learn.microsoft.com/en-us/exchange/sharing/manage-calendar-delegate-access).
2. Open **Settings > Integrations > Communication > Outlook Calendar**. Select the installed account and choose **Manage**.
3. Turn on **Shared calendars** and complete Microsoft consent for the same account. For editing or invitation replies, also turn on **Allow write access** and complete its reconnect. Calendar write access is separate from Outlook Email write access.
4. Return to Calendar and select the calendar under **Connected calendars**. For an invitation response, choose it under **Reply calendar** in Email and review **Reply as** before sending.

The option is available with direct Microsoft sign-in and **Use your own OAuth app**. Older managed connections keep their existing fixed permissions. A cancelled consent or a grant without the requested permissions does not enable shared access. If a shared calendar is missing, check that it was added in Outlook and that the owner and your administrator allow access.

Turning off **Shared calendars** blocks new shared-calendar reads and writes in Calendar, Email replies and assistant actions. It does not revoke Microsoft-side consent or erase previously loaded events. Calendar can retain those events in its session cache until refreshed or closed. Turning off **Allow write access** leaves permitted reads available.

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
