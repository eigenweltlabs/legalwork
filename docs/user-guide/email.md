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

## Connect iCloud or another mail service

1. Open **Settings > Integrations > Communication** and select **iCloud / IMAP / SMTP**. You can search the catalogue for IMAP or iCloud.
2. Under **Connected accounts**, select **Add account**, then choose **iCloud Mail** or **Other IMAP account**. The form is already open when no account is stored.
3. For iCloud, enter the mail username and an app-specific password from your Apple Account. For another service, enter the provider's IMAP server, direct TLS port, username and password. Folder selection is optional. Insecure connections and STARTTLS are not supported.
4. Select **Connect securely**. When connected, the account appears in Email and begins downloading unless you previously paused it.
5. In the same integration, configure its SMTP sending details. Use the provider's server addresses and credentials. Mail accounts' **Sending** section also provides these per-account controls.

Use **Mail accounts** for notification preferences, sender signatures, agent access, local retention, backup and archive import or export. Disconnecting an account and deleting local copies are separate operations.

Use **New mail**, **Reply**, **Reply all** or **Forward** to compose. The composer has compact recipient and subject rows above a document-style writing area. Use **Toggle rich text** for formatting and the attachment controls to add files or inline images. Review the account, sender, recipients, body and attachments before sending. **Drafts** keeps unfinished messages, and **Outbox** shows queued submissions and outcomes. A submission with an uncertain result must be checked before retrying.

Under **Mail accounts > Data & access**, review the per-account agent policy. Connecting an account does not approve sending or deleting mail for the assistant. The same section contains local retention, backup, restore and archive import/export controls. Disconnecting and deleting local data are separate actions; review each dialog's scope.

Open **Settings > Integrations > Communication**. Search for **Gmail** or **Outlook Email** and press its **+** button to connect. Select an installed account and choose **Manage** to open its settings. These connectors let the assistant search and read mail, retrieve supported attachments and prepare editable email drafts. Connecting Google Drive, Google Calendar or an Office add-in does not connect email.

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

Shared and delegated calendars additionally require permissions granted by their owner and the provider. Current direct Microsoft consent does not request shared-calendar scopes; such calendars may be read-only or unavailable for replies. This does not add a second sign-in flow or silently broaden your permissions. Reply-email transport over IMAP/SMTP, automatic calendar import, proposing new times and full calendar-client parity are not available. Other email services can supply invitation attachments, then use a matching connected Google or Outlook calendar for the reply.

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

## Disconnect and troubleshoot

| Situation | What to do |
| --- | --- |
| Connect is disabled | Check worker availability, the chosen connection method, Eigenwelt sign-in or saved OAuth app details. Save pending app-detail edits first. |
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
