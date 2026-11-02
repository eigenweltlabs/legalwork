# Add Gmail or Outlook email

Open in LegalWork: [Integrations](legalwork://app/settings/extensions/mcp), [Account](legalwork://app/settings/account).

Open **Settings > Integrations > Communication**. Search for **Gmail** or **Outlook Email** and press its **+** button to connect. Select an installed account and choose **Manage** to open its settings. These connectors let the assistant search and read mail, retrieve supported attachments and prepare editable email drafts. Connecting Google Drive, Google Calendar or an Office add-in does not connect email.

## Connect Outlook directly with Microsoft

1. Open **Settings > Integrations**, open **Communication**, then press **+** next to **Outlook Email**.
2. Leave **Allow write access** off to read and search mail. Enable it if you also want drafts, sending or mailbox organization, then review Microsoft's requested permissions.
3. Select **Connect Outlook Email**. Complete Microsoft sign-in in the browser with an account that has an Outlook mailbox, and review the LegalWork consent screen. An Azure work account alone does not provide a mailbox.
4. Return to LegalWork, select **Refresh** if needed, then **Test connection**. If you connected through Outlook Calendar, select **Activate Outlook Email** first.

LegalWork includes its Microsoft app configuration. You do not need an Eigenwelt account, Nango, your own OAuth app, a client secret or a model-provider API key to connect. Using the assistant afterwards requires a configured model. Some work or school accounts require administrator consent; follow your organization's approval process if Microsoft blocks sign-in.

One account is supported per connector. Outlook Email and Outlook Calendar share one Microsoft account but have separate activation controls. Deactivating one leaves the other active. Disconnecting that account disconnects both. If the panel reports multiple legacy accounts, disconnect the extra connections before continuing.

Existing connections created with **Connect with Eigenwelt** keep that sign-in method when reconnected. To switch an existing Outlook connection to direct Microsoft sign-in, disconnect it, then select **Connect Outlook Email** again.

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
| Connection needs refreshing | Use **Refresh**, **Test connection**, then **Reconnect** if authorization expired. |
| Attachment cannot be downloaded | Open a chat in an authorized project and check available disk space and the returned error. If an older chat reports a missing attachment, ask the assistant to read the email again and retry. Retry an interrupted download; incomplete copies are removed. Outlook cloud links and other non-file attachment types are not supported by this download action. |
| Remove access | Select **Disconnect**. For Outlook this disconnects the shared Email and Calendar account. Review provider-side app permissions separately if you also want to revoke consent. |

Disconnecting does not delete mailbox messages, previously downloaded attachments or chat history. Mail read into an assistant task is included in that task's model context. With **Microsoft sign-in** or your own OAuth app, LegalWork authenticates and renews tokens directly with the provider. With **Connect with Eigenwelt**, Nango manages sign-in and token renewal; LegalWork retrieves mail content directly from the provider.

## Firm-provided mail connectors

A firm can also supply a custom MCP connector. Open **Settings > Integrations**, then choose **Custom** in the catalogue to create a plugin with that connector. Use the supplied MCP address and authentication details. A Gmail or Outlook webmail address is not an MCP endpoint. Custom connectors determine their own account support and actions; check their actual tools rather than assuming the built-in connector's behavior.

Related: [Integrations](integrations.md), [Settings and privacy](settings-privacy.md), [Troubleshooting](troubleshooting.md).
