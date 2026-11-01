# Email

Open in LegalWork: [Email](legalwork://app/mail), [Mail accounts](legalwork://app/settings/mail-accounts), [Integrations](legalwork://app/settings/extensions/mcp), [Account](legalwork://app/settings/account).

## Read email in LegalWork

Select **Email** in the narrow global sidebar, beside Calendar. Email stays available when you switch projects or open Settings. Double-click its icon to open a separate window. Use **Settings > Customization > Sidebar** to move or hide the icon.

The desktop reader provides a unified Inbox, account folders, conversations, search, Drafts and Outbox. Use **Settings** in Email to open **Mail accounts**. This desktop service keeps an encrypted local copy, including downloaded attachments. Mail that has finished downloading remains available offline; pending content and sync errors remain visible. Reading an item can mark it read on its provider.

Connect accounts in **Settings > Integrations > Communication**. Gmail and Outlook Email use the same sign-in, account activation and **Allow write access** setting for Email and the assistant. After the mailbox identity is verified, the local reader downloads mail automatically. You can also choose **Open Email** on the provider's Integrations page. Connecting Outlook Calendar alone requires **Activate Outlook Email** before its mailbox appears.

In **Mail accounts > Accounts**, inspect sync progress, resume a paused account or choose **Manage in Integrations**. New account setup opens Integrations. Reading remains available with write access off. Sending, provider drafts and mailbox organization require the corresponding permissions; enabling writes does not add provider consent. The reader keeps local drafts while offline. If you reconnect as a different person, their mailbox appears separately. Previous local data is retained and is never attached to another account just because its address looks similar.

Accounts created by an earlier development build move to Integrations after LegalWork verifies that the old authenticated account and the connected account identify the same mailbox. Saved names and addresses alone are not enough. The old OAuth credentials are removed after that proof. Existing local account IDs, originals, drafts and action history stay in place.

If the current Integrations mailbox already has its own local store, the older one is labeled **Retained local copy**. Open it in Email to read its saved mail, inspect drafts or review Outbox history. It does not sync, send or publish drafts, and does not add duplicate messages to the unified Inbox, unread badge or notifications. To continue a retained draft, open it and choose the current **Account** in the composer. LegalWork copies the draft and its attachments and keeps the original. Review the copied message before sending.

Old queued submissions are not sent automatically after migration. Review a failed submission before retrying it from the current account. An uncertain result stays uncertain until **Check Sent for acceptance** finds the exact message or you verify its outcome yourself. Checking Sent never resubmits a message. In a retained copy, you can cancel a queued item or edit and copy its draft to the current account; retrying from that copy is disabled.

If the old account cannot be verified, its data and reconnect controls remain available. Reconnect that retained account to prove its identity, and connect the same mailbox in Integrations. Different identities remain separate. Provider discovery and verification run in the background; retained local mail can open while they are unavailable.

## Download status and local privacy

In **Settings > Mail accounts > Accounts**, inspect the account's sync progress and errors. Message discovery, saved original bytes, readable bodies, attachments and search indexing are separate steps. A message header or attachment filename alone does not mean its content is saved. Mail you have never opened still needs its accessible original and attachment bytes downloaded for complete offline use. Pending work, unavailable originals, protected content and excluded provider scopes must be accounted for; a search index is not proof of a complete mailbox.

Counts refer to local provider identities. Gmail labels can contain the same message, and IMAP copies in different folders can have different identities. Do not compare a unified conversation count directly with a provider's folder count. A provider may withhold protected messages, cloud-reference attachments, inaccessible shared folders or other content. Those limitations do not disappear when a sync pass ends. Downloaded content remains readable offline; missing content needs the provider or a supported authorized application.

The Email store is encrypted on this computer. Reading, local lexical search and composing a local draft do not themselves require a remote model. Mail supplied to an assistant task enters that task's model context, and remote processing follows the selected provider and the permissions granted for that task. Matter filing, connected storage and exports create separate copies at their chosen destinations. Disconnecting an integration does not recall those copies or remove past chat content.

## Connect iCloud or another mail service

1. Open **Settings > Integrations > Communication** and select **iCloud / IMAP / SMTP**. You can search the catalogue for IMAP or iCloud.
2. Under **Connected accounts**, select **Add account**, then choose **iCloud Mail** or **Other IMAP account**. The form is already open when no account is stored.
3. For iCloud, enter the mail username and an app-specific password from your Apple Account. For another service, enter the provider's IMAP server, direct TLS port, username and password. Folder selection is optional. Insecure connections and STARTTLS are not supported.
4. Select **Connect securely**. When connected, the account appears in Email and begins downloading unless you previously paused it.
5. In the same integration, configure its SMTP sending details. Use the provider's server addresses and credentials. Mail accounts' **Sending** section also provides these per-account controls.

Use **Mail accounts** for notification preferences, sender signatures, agent access, local retention, backup and archive import or export. Disconnecting an account and deleting local copies are separate operations.

Native JMAP and Exchange Web Services (EWS) connections are not available. For Fastmail, use provider-supplied IMAP/SMTP settings through the integration above; live Fastmail certification is still pending. For an on-premises Exchange mailbox, ask its administrator whether direct TLS IMAP and SMTP are permitted. The Outlook Email integration connects cloud mailboxes through Microsoft Graph; it does not connect an on-premises mailbox merely because the organization uses Microsoft sign-in.

Use **New mail**, **Reply**, **Reply all** or **Forward** to compose. The composer has compact recipient and subject rows above a document-style writing area. Use **Toggle rich text** for formatting and the attachment controls to add files or inline images. Review the account, sender, recipients, body and attachments before sending. **Drafts** keeps unfinished messages, and **Outbox** shows queued submissions and outcomes. A submission with an uncertain result must be checked before retrying.

Under **Mail accounts > Data & access**, review the per-account agent policy. Connecting an account does not approve sending or deleting mail for the assistant. The same section contains local retention, backup, restore and archive import/export controls. Disconnecting and deleting local data are separate actions; review each dialog's scope.

Open **Settings > Integrations > Communication**. Search for **Gmail** or **Outlook Email** and press its **+** button to connect. Select an installed account and choose **Manage** to open its settings. These connectors let the assistant search and read mail, retrieve supported attachments and prepare editable email drafts. Connecting Google Drive, Google Calendar or an Office add-in does not connect email.

## Schedule a message

1. Prepare the message in Email and wait for **Saved locally**. Choose **Schedule send** beside **Send**.
2. Enter **Date and time** and check **Time zone**. Choose a future time within one year. If the clock repeats during a daylight-saving change, select the intended **Occurrence** by its UTC offset. A time skipped by a clock change cannot be selected.
3. Review the subject, sender, recipients and **Send at**. **Execution** is **On this device**. Confirm with **Schedule send**. The message appears in **Outbox**, with **Scheduled** shown before its due time.
4. To change the time, select the message in Outbox and choose **Reschedule send**, then **Save schedule**. This is available only while the send is still queued. Use **Cancel queued send** to cancel before dispatch. **Continue editing** cancels the queued send before reopening its draft; schedule the edited message again when ready.

The schedule stores a fixed instant and its chosen display zone. Changing your computer's time zone does not move it. The queued recipients, body and attachments form a saved snapshot; later draft edits do not change that snapshot.

This is a local schedule for Gmail, Outlook Email and configured SMTP accounts. LegalWork does not upload a timed send to the provider or keep this computer awake. The desktop app must be running, awake, with the screen and Email unlocked, connected to the mail service and not paused. Closing the app, locking Email, sleep or a paused mail runtime delays execution. On macOS and Windows, screen lock also suspends mail. A due message stays on this device and is picked up when the runtime becomes available. Temporary connection failures before dispatch keep the message queued for another attempt. Permanent account, sender or permission errors need attention in Outbox. The selected time is an earliest attempt time, not a guaranteed delivery time.

Once dispatch starts, a cancellation cannot guarantee that the message was stopped. An uncertain result is never sent again automatically. Use **Check Sent for acceptance** to look for matching provider evidence. Rescheduling cannot restart an uncertain send.

## Snooze a conversation

Select one conversation or message, then choose **Snooze** (the clock button) or right-click it and choose **Snooze**. Enter **Date and time**, check **Time zone** and review **Applies to**. A conversation snooze covers its currently downloaded Inbox messages, up to 1,000. A message without a conversation is snoozed individually. The same daylight-saving choices and one-year time limit apply as for scheduled send. Confirm with **Snooze**.

Snoozed messages leave this client's Inbox and unread count until their due time. They remain readable in **All mail**, search and **Snoozed**. Open **Snoozed** in Email's mailbox navigation to inspect them; the list shows their return dates. Select an item and open **Snooze** to choose another time or **End snooze** to end it early.

This is local to LegalWork. It does not move provider folders, change read flags or synchronize a snooze to Gmail, Outlook or another computer. Read-only provider access is sufficient. Retained local copies and imported archives cannot be snoozed. Ending a snooze does not move an archived or deleted provider message back into Inbox.

The chosen instant and zone survive restarting or locking Email. Due conversations return to the top of this client's Inbox when Email is available, including offline with downloaded mail. Their original email dates remain unchanged. Closing the app or locking Email delays the refresh until it is available again; LegalWork does not wake the computer. Newly downloaded messages, or messages moved into Inbox, bring their snoozed conversation back early. Historical mail discovered later can also count as a new local Inbox message. Notifications keep the existing opt-in and at-most-once policy.

## Local rules for new Inbox mail

Open **Settings > Mail accounts > Rules**, select an account and choose **Add rule**. Enter a **Name** and **Order (first match only)**. Set **From address equals**, **Subject contains (and)**, or both. The sender condition matches one parsed email address, not a display name. Subjects use a literal, case-insensitive match. Both conditions must match when both are filled in.

Choose **Mark as read**, **Flag**, **Archive** or **Snooze conversation**. Snooze also requires **Snooze minutes** and **Time zone**; it uses an elapsed duration from local processing, not a wall-clock appointment. It covers the current Inbox conversation and preserves a snooze you already set. Switch **Enabled** on, then **Save**. New rules start disabled. Up to 20 rules are allowed per account. Lower order numbers run first; equal numbers follow the displayed order. Only the first matching rule acts on a message.

These rules belong to this LegalWork installation. They are separate from Gmail filters, Outlook server rules and provider-side snooze. They reuse the account connected in Integrations, or the configured IMAP account. They cannot send mail, delete messages, run scripts, invoke an assistant or file material into a matter or another account. Provider changes require the account's existing write permission. Snooze is local and needs only read access.

Rules apply only to new Inbox messages identified through an established provider sync stream after the rule was saved and enabled. Initial downloads, historical imports, a reset Outlook delta baseline and an IMAP UIDVALIDITY replacement are excluded. Provider receipt dates must also be at or after activation. Sent, Spam and Trash are excluded. There is no **Run on existing mail** action. Editing, changing order or enabling a rule applies its new version to future arrivals. Disabling or deleting it prevents unclaimed work; a provider action already queued stays in **Mail activity**, where it can be reviewed or cancelled before dispatch.

The desktop app and mail service must be running, awake, unlocked and not paused. LegalWork does not wake the computer or install provider rules. Provider sync needs a connection. Catch-up processes verified new arrivals when sync resumes, rather than promising an exact execution time. Captured arrivals awaiting downloaded content or permission are retried for up to seven days, then skipped. Rules do not provide guaranteed delivery or cross-device automation.

Use **Refresh** to update readiness and **Recent activity**. **Waiting for first sync**, **Sync paused**, **Write permission required** and **Account unavailable** identify what is blocking execution. **Connection changed: review rule** requires opening **Edit rule**, checking the conditions and choosing **Save** after reconnecting. That review does not replay earlier arrivals. Ordinary restarts preserve rules; restoring an encrypted backup disables them.

**Queued** means an action has entered the existing mail action queue. **Confirmed** means the provider action was confirmed. **Uncertain: review Mail activity** is never retried automatically. Review uncertain or failed work in Email's **Mail activity** controls. Changing a read flag, archiving, snoozing, waking a conversation or replaying a provider page cannot trigger the rule again for the same provider message identity.

## Meeting invitations

Downloaded `text/calendar` and `.ics` attachments appear above the message body. The preview shows the title, organizer, location and dates. **Details** shows the description, attendees and standard recurrence settings. **Updated invitation**, **Cancelled**, **Repeats**, **Occurrence** and **Delegated** describe the attached calendar data. They do not verify the sender or prove that a connected calendar has applied an update.

Timed invitations with a resolved time zone display in your computer's time zone. Floating times show **No time zone**. Ambiguous daylight-saving times retain their original wall time and source zone. All-day ranges show the last included day, rather than the exclusive end date used by iCalendar. A cancellation without dates can still be read.

Select **Calendar** to open LegalWork's existing Calendar at the invitation date. Connected Google Calendar and Outlook Calendar accounts keep their existing Integrations sign-in and visibility settings. This opens the date without importing or changing an event.

To respond in Email:

1. Select **Reply** below the invitation. Choose **Reply calendar** from your connected Google Calendar or Outlook Calendar accounts. If none are connected, select **Integrations** and connect a calendar there. Calendar write access and the provider's calendar permissions are required. Email write access alone does not grant Calendar writes.
2. Choose **Accept**, **Tentative** or **Decline**. LegalWork looks up an existing event in that calendar and opens **Review reply**. Check the calendar account, **Reply as**, organizer, dates and **Applies to**. A series reply applies to the **Entire series**. An occurrence reply applies to one identified occurrence. Delegated calendars show their invited participant under **Reply as**, which can differ from the account you signed in with.
3. If the organizer has updated the event, **Calendar event updated** appears and the review shows the current Calendar event. Select **Send reply** to submit the reviewed response through that existing integration, or **Cancel** to leave it unchanged.

**Response saved** means the selected calendar reports the response. It does not prove delivery of a notification email. **Reply status unknown** means the provider outcome could not be confirmed, including an asynchronous Microsoft response. Select **Check reply** to read the provider state again. This does not send another reply. Uncertain replies survive restarts and are never retried automatically. Use **Open in provider** to check an unresolved result in the calendar application. A declined Microsoft event can disappear before its response is readable; that case remains unknown locally.

Invitations can be read offline after download; replying requires an online calendar. The preview supports UTF-8 iCalendar attachments up to 256 KB with at most 20 events. Replies require an existing matching event, the same organizer and an invited participant belonging to the selected calendar. Cancelled invitations and events cannot receive a reply. Floating times remain readable; occurrence replies need an unambiguous original time. Google occurrence lookup uses its original start, including moved occurrences. Outlook occurrence lookup is bounded to four days around its original timed start; all-day occurrences and occurrences moved beyond that window require the provider application. Provider updates between review and dispatch reject the review when detected. Google also checks its event version on the write; Microsoft's reply action has no documented atomic version guarantee.

Shared and delegated calendars additionally require permissions granted by their owner and the provider. For Outlook, enable **Shared calendars** and **Allow write access** in the existing Outlook Calendar integration and complete the same account's consent. See [shared Outlook calendar setup](calendar.md#shared-outlook-calendars), including owner and delegate permissions. Reply-email transport over IMAP/SMTP, automatic calendar import, proposing new times and full calendar-client parity are not available. Other email services can supply invitation attachments, then use a matching connected Google or Outlook calendar for the reply.

## Connect Outlook directly with Microsoft

1. Open **Settings > Integrations**, open **Communication**, then press **+** next to **Outlook Email**.
2. Leave **Allow write access** off to read and search mail. Enable it if you also want drafts, sending or mailbox organization, then review Microsoft's requested permissions.
3. Select **Connect Outlook Email**. Complete Microsoft sign-in in the browser with an account that has an Outlook mailbox, and review the LegalWork consent screen. An Azure work account alone does not provide a mailbox.
4. Return to LegalWork, select **Refresh** if needed, then **Test connection**. If you connected through Outlook Calendar, select **Activate Outlook Email** first.

LegalWork includes its Microsoft app configuration. You do not need an Eigenwelt account, Nango, your own OAuth app, a client secret or a model-provider API key to connect. Using the assistant afterwards requires a configured model. Some work or school accounts require administrator consent; follow your organization's approval process if Microsoft blocks sign-in.

One account is supported per connector. Outlook Email and Outlook Calendar share one Microsoft account but have separate activation controls. Deactivating one leaves the other active. Disconnecting that account disconnects both. If the panel reports multiple legacy accounts, disconnect the extra connections before continuing.

Existing connections created with **Connect with Eigenwelt** keep that sign-in method when reconnected. To switch an existing Outlook connection to direct Microsoft sign-in, disconnect it, then select **Connect Outlook Email** again.

## Personal contacts and shared mailboxes

1. Open **Settings > Integrations > Communication** and select Gmail or Outlook Email.
2. For direct Microsoft sign-in or **Use your own OAuth app**, turn on **Personal contacts**. For an existing connection this starts **Reconnect**. Complete provider consent with the same account. A new connection requests the selected permission during sign-in.
3. Return to **Mail accounts > Accounts > Address books** and select **Connect contacts** to download recipient suggestions. Use **Sync now** to refresh them and **Remove local contacts** to clear the downloaded address book. Turning off **Personal contacts** in Integrations stops provider access; downloaded suggestions remain until you remove them locally.

Google's shared-app connection has fixed permissions. The optional controls appear with **Use your own OAuth app**; its Google project must have People API enabled, as described in [Google's setup guide](https://developers.google.com/people/v1/getting-started). Existing broker connections continue to work for email. See [OAuth app details](#use-your-own-oauth-app) before changing connection methods, and export needed local mail before disconnecting its original account.

For a Microsoft work account, turn on **Shared mailboxes** in Outlook Email's Integrations settings and complete the same account's provider consent. Leave **Allow write access** off for reading. To request shared-mailbox writes and sending, enable it before connecting or reconnecting. Then open **Mail accounts > Accounts > Microsoft shared and delegated mailboxes > Add shared mailbox**, enter the mailbox address and choose **Verify mailbox access**. Select only the write and sender rights your administrator has granted. The Microsoft consent and Exchange mailbox permissions are both required, as described in [Microsoft's shared-mailbox guide](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders). Shared mailboxes use the signed-in account's existing connection.

## Connect Gmail with Eigenwelt

1. Sign in under **Settings > Account**.
2. Open **Settings > Integrations**, open **Communication**, then press **+** next to **Gmail**. In its connection panel, choose **Connect with Eigenwelt** under **Connection method**.
3. Leave **Allow write access** off for reading and searching. Enable it if you want to save drafts or send emails, then review the permissions requested during sign-in.
4. Select **Connect Gmail**. Keep the connection panel open while completing Google sign-in in the browser. Choose the intended account and review its consent screen.
5. Return to LegalWork and select **Refresh** if necessary. Use **Test connection** to check access directly with the provider.
6. Ask the assistant to search the connected mailbox for a specific sender, subject or matter. Start with a read request to confirm the intended account is being used.

If **Connect with Eigenwelt** is unavailable, check Eigenwelt sign-in and the panel's availability message. The alternative below uses your own OAuth application. Administrator consent may be required for a work or school account; follow your organization's approval process rather than repeatedly attempting a blocked sign-in.

## Use your own OAuth app

For Gmail, choose **Use your own OAuth app** under **Connection method**. For Outlook, open **Connection details & privacy > Use your own OAuth app**. This optional override does not require an Eigenwelt account. Use the configuration supplied by your administrator, or configure an application with the provider:

- **Gmail:** Create a Desktop app OAuth client in Google Cloud and enable the Gmail API for its project. Enter the **Client ID** and **Client secret** where the panel requests them.
- **Outlook Email:** Register a Mobile and desktop application in Microsoft Entra. Add the exact **Redirect URI** shown by LegalWork. Enter the **Client ID** and, if your organization requires it, its **Tenant ID** or domain. A client secret is not needed for this flow.

Use the panel's **Permissions** list for the required scopes. Select **Save app details**, then connect and complete provider consent. Changing app details requires reconnecting the account. Details and tokens are encrypted in the local OAuth vault. Use **Connection details & privacy** to inspect the method and saved application configuration; enter secrets in that form rather than chat. To reset a Microsoft override, select **Use LegalWork app and disconnect**, then connect again.

Complete browser sign-in on the same computer as the LegalWork server. This desktop callback flow does not forward sign-in from your laptop to a remote worker.

## Download attachments

Open a chat in the project where you want to keep the files. Ask the assistant to find the email and download its attachments. For example: “Find the email from Müller about the contract and download its PDF attachment into this project.”

Attachments are saved in your project under `.legalwork/attachments/email/`, inside the hidden `.legalwork` folder, with a separate folder for each download. Files dragged into chat use the same `.legalwork/attachments/` location. The original filename is kept where possible; characters that cannot be used safely in filenames are replaced. Downloading another attachment with the same name keeps both files.

The assistant receives the saved file's path, name, type and size, and can use that path to read or open it. File contents are not inserted into the chat as encoded data. There is no LegalWork attachment-download size limit; mailbox-provider restrictions and available disk space still apply. Downloads require an authorized project folder and are unavailable on a read-only worker. They do not require **Allow write access** to the mailbox.

## Drafts and sending

Ask the assistant to draft an email. If exactly one email account is connected and active, the preview uses that account automatically. If both Gmail and Outlook Email are connected, the assistant asks which account to use. You can name the account in your request to choose it directly. With no active email account, the assistant prepares an ordinary local draft. Ask for a **local draft without a connected account** if that is what you want even when an account is connected. Outlook Calendar alone does not count as an email connection.

The assistant can prepare a local email preview containing recipients, subject, body and supported attachments. Preparing that preview does not send it or save it in your mailbox. Review and edit it in LegalWork, then use the card's save action to put it into the connected mailbox. Sending is a separate action from the card. Inspect To, Cc, Bcc, subject, body and attachments before sending.

**Allow write access** and provider consent are separate requirements. Turning the setting on does not expand an account's previously granted scopes; use **Reconnect** if it only has read permissions. Turning it off blocks LegalWork write actions but does not revoke provider-side permissions.

If a saved draft changes in Gmail or Outlook, LegalWork can require you to review the provider's version instead of sending an outdated local copy. If delivery is marked uncertain, check the mailbox before retrying. A lost response is not proof that sending failed.

## Signed, encrypted and Microsoft protected mail

LegalWork can display the clear text of a detached S/MIME-signed email, but it does not verify its signature, certificate, sender address or revocation status. A visible `.p7s` signature attachment does not mean the message is verified. Unverified clear text remains searchable, including text whose signature would fail verification.

Bodies inside opaque signed or encrypted S/MIME containers are not decoded. LegalWork does not import signing/decryption certificates or use private keys. If **No message body is available yet** appears for such a message, waiting for sync cannot add decryption support. Use an authorized mail application with the required certificate/key. The encrypted local Email database protects local storage; it does not encrypt outgoing email.

Microsoft-protected mail may expose only an outer wrapper or an unavailable body. LegalWork does not acquire MIP content licenses, decrypt RPMSG, or enforce Microsoft protection policies. A mailbox connection or **Allow write access** is not a content license. Open the message through Microsoft’s supported provider/application when protection is required.

To export available original bytes, open **Settings > Mail accounts > Data & access**, select **Export account**, choose **EML with manifest** or **MBOX with manifest** under **Export format**, then select **Choose export folder…**. Both formats preserve the protected original without converting it into a verified or decrypted copy. An unavailable original is reported as incomplete. Technical access to bytes does not establish permission to export protected content.

Ordinary reply/forward and attaching a signature/certificate file do not sign, encrypt or preserve Microsoft protection on a new message. Use a supported protected-composition workflow in the provider or another authorized mail application when that protection is required.

## Email on more than one device

Downloaded mail, local drafts, Outbox, snoozes and rules belong to this computer. Connecting the same provider on another computer does not transfer that local state. Provider read flags and folders appear through normal provider sync. Automatic device-to-device cache sync and a firm-hosted Email worker are not available. Connecting the assistant to a remote LegalWork server does not give that server access to this local mail cache.

Open **Settings > Mail accounts > Data & access** for backup and export controls. Restoring an encrypted mail backup does not restore provider credentials or resume old pending work. Review the account connection in Integrations before creating fresh provider actions. Restoring a backup does not resume old sends or enable its rules.

## Back up, restore and remove local copies

### Create an encrypted backup

1. Open **Settings > Mail accounts > Data & access > Retention and encrypted recovery**.
2. Under **Encrypted backup and restore**, enter a **Recovery passphrase (16+ characters)** and repeat it in **Confirm passphrase for new backup**. Keep the passphrase separately from the backup.
3. Select **Choose backup destination…** and choose a folder. LegalWork creates a new encrypted backup, verifies it and reports its inventory. Let verification finish; **Cancel recovery operation** stops a pending operation.
4. After success, Email is closed. Reopen **Email** when ready. Preserve the backup and recovery passphrase. A backup can contain incomplete local parts, so check the reported incomplete-part count; it cannot add content the provider never supplied.

### Restore an encrypted backup

1. Keep a separate backup of the current store if you need its newer local work. A restore replaces the active mail store.
2. Open the same **Encrypted backup and restore** controls, enter the backup's recovery passphrase and select **Replace current mail with this backup**.
3. Select **Choose backup to restore…**, choose the encrypted backup folder and wait for verification. If it fails or is cancelled, keep the source backup and passphrase and reopen Email to inspect the active state before retrying.
4. After success, reopen **Email** to inspect restored local data. Provider credentials are removed; old sends, provider-draft mappings and file/filing jobs are quarantined. Rules are disabled. Review Integrations and reconnect explicitly before creating fresh provider actions. Restoring cannot undo a send already accepted by a provider.

### Review local retention or remove an account's local data

1. Open **Settings > Mail accounts > Data & access > Retention and encrypted recovery**, then find the account. Leave **Keep provider-deleted copies for days** blank for indefinite retention, or enter the desired number of days.
2. Choose **Deletion scope**: **Provider-deleted copies past this age**, **All local mirror messages**, or **Disconnected account and local history**. Disconnect the provider first for account removal. Outlook's shared Email/Calendar account disconnect affects both integrations; it does not delete local mail by itself.
3. Select **Save retention and review deletion**. Review the counts and blockers. Retained originals and matter-filed records have separate lifecycles; resolve the displayed blockers rather than assuming every reference can be deleted. Offline archives require **Include this offline archive explicitly**.
4. If you intend that exact local deletion, enter `DELETE LOCAL COPIES` and select **Delete selected local copies**. This action pauses background mail. To resume afterward, open **Mail accounts > Notifications > Background mail** and select **Resume mail** when ready.

Deleting local copies does not delete provider mail, exported files, filed matter records or existing chat history. Leaving an account connected allows subsequent sync to download accessible provider content again.

## Disconnect and troubleshoot

### Export mail diagnostics

1. Open **Settings > Mail accounts > Data & access**.
2. Under **Diagnostics**, select **Export diagnostics**. Your browser or desktop download location receives `legalwork-mail-diagnostics-YYYY-MM-DD.json`.
3. Review the file before sharing it with support. It contains the local storage state, schema version and aggregate counts for messages, originals, attachments, sync jobs, drafts, queued actions, schedules, search and invitation replies. It excludes account and message identifiers, addresses, subjects, message/attachment contents, credentials, file paths and provider response text.

The report reads saved local observations. It does not contact the provider, compare mailbox counts, verify content hashes, send mail or retry work. **Stored** counts describe local manifests; missing or unenumerated attachments are not implied complete. Scheduled counts include only queued/retrying scheduled submissions; **due** means their earliest attempt time has passed, not that they were sent. Collection never unlocks Email. A report collected while storage is locked or unavailable contains that state without storage counts.

This mail report is different from **Settings > Updates > Support logs** and technical diagnostics, which can include tool arguments, results and logs. Use the mail report first for mail incidents. Counts can still reveal mailbox volume, so share them only with the agreed recipient. Export does not upload the file.

### Common problems

| Situation | What to do |
| --- | --- |
| Connect is disabled | Check worker availability, the chosen connection method, Eigenwelt sign-in or saved OAuth app details. Save pending app-detail edits first. |
| Gmail initial download is slow | Original messages consume more provider quota than metadata, so downloads are paced. Check sync progress in **Mail accounts > Accounts** and leave sync running. Provider throttling can add waits. |
| Browser sign-in expired or was cancelled | Cancel the pending attempt, reconnect and keep the LegalWork panel open until completion. |
| Outlook account exists but mail is unavailable | Activate **Outlook Email** separately from **Outlook Calendar**, then test the connection. |
| Assistant asks which email account to use | Reply Gmail or Outlook Email. It will then prepare a preview for that account. |
| Can read but cannot save or send | Enable **Allow write access**, reconnect if scopes are missing, and check organization policy. |
| Assistant reports invalid draft details | Ask it to correct the listed fields and retry with the same connected account. This error occurs before a mailbox write and does not require reconnecting. Previously created local drafts stay local; request a new draft using the named connection. |
| Organization blocks consent | Give the administrator the provider's error and application details. |
| Connection needs refreshing | Open the provider in Integrations. Use **Refresh**, **Test connection**, then **Reconnect** if authorization expired. Email reuses the renewed connection. |
| Attachment cannot be downloaded | Open a chat in an authorized project and check available disk space and the returned error. If an older chat reports a missing attachment, ask the assistant to read the email again and retry. Retry an interrupted download; incomplete copies are removed. Outlook cloud links and other non-file attachment types are not supported by this download action. |
| Remove access | Use **Manage in Integrations**, then **Disconnect** for Gmail or Outlook Email. For IMAP, use the account's **Disconnect** action. For Outlook this disconnects the shared Email and Calendar account. Review provider-side app permissions separately if you also want to revoke consent. |

Disconnecting does not delete mailbox messages, previously downloaded attachments or chat history. Mail read into an assistant task is included in that task's model context. With **Microsoft sign-in** or your own OAuth app, LegalWork authenticates and renews tokens directly with the provider. With **Connect with Eigenwelt**, Nango manages sign-in and token renewal; LegalWork retrieves mail content directly from the provider.

## Firm-provided mail connectors

A firm can also supply a custom MCP connector. Open **Settings > Integrations**, then choose **Custom** in the catalogue to create a plugin with that connector. Use the supplied MCP address and authentication details. A Gmail or Outlook webmail address is not an MCP endpoint. Custom connectors determine their own account support and actions; check their actual tools rather than assuming the built-in connector's behavior.

Related: [Integrations](integrations.md), [Settings and privacy](settings-privacy.md), [Troubleshooting](troubleshooting.md).
