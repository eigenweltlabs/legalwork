# Add Gmail or Outlook email

Open in LegalWork: [Connectors](legalwork://app/settings/extensions/mcp), [Account](legalwork://app/settings/account).

Open **Settings > Integrations**, press **Add**, then select **Plugins** to open the **Plugin catalogue**. Search for and select **Gmail** or **Outlook Email** to open its connection panel. The **Add** step is required to find a connector you have not added yet; an already added connector can be opened from the library. These connectors let the assistant search and read mail, retrieve supported attachments and prepare editable email drafts. Connecting Google Drive, Google Calendar or an Office add-in does not connect email.

## Connect with Eigenwelt

1. Sign in under **Settings > Account**.
2. Open **Settings > Integrations**, press **Add**, choose **Plugins**, then search for and select **Gmail** or **Outlook Email**. In its connection panel, choose **Connect with Eigenwelt** under **Connection method**.
3. Leave **Allow write access** off for reading and searching. Enable it if you want to save drafts or send emails, then review the permissions requested during sign-in.
4. Select **Connect Gmail** or **Connect Outlook Email**. Keep the connection panel open while completing Google or Microsoft sign-in in the browser. Choose the intended personal or work account and review its consent screen.
5. Return to LegalWork and select **Refresh** if necessary. Use **Test connection** to check access directly with the provider.
6. For Outlook, confirm that **Outlook Email** is active. If the account was connected through Outlook Calendar, select **Activate Outlook Email**.
7. Ask the assistant to search the connected mailbox for a specific sender, subject or matter. Start with a read request to confirm the intended account is being used.

One account is supported per connector. Outlook Email and Outlook Calendar share one Microsoft account but have separate activation controls. Deactivating one leaves the other active. Disconnecting that account disconnects both. If the panel reports multiple legacy accounts, disconnect the extra connections before continuing.

If **Connect with Eigenwelt** is unavailable, check Eigenwelt sign-in and the panel's availability message. The alternative below uses your own OAuth application. Administrator consent may be required for a work or school account; follow your organization's approval process rather than repeatedly attempting a blocked sign-in.

## Use your own OAuth app

Choose **Use your own OAuth app** under **Connection method**. This does not require an Eigenwelt account. Use the configuration supplied by your administrator, or configure an application with the provider:

- **Gmail:** Create a Desktop app OAuth client in Google Cloud and enable the Gmail API for its project. Enter the **Client ID** and **Client secret** where the panel requests them.
- **Outlook Email:** Register a Mobile and desktop application in Microsoft Entra. Add the exact **Redirect URI** shown by LegalWork. Enter the **Client ID** and, if your organization requires it, its **Tenant ID** or domain. A client secret is not needed for this flow.

Use the panel's **Permissions** list for the required scopes. Select **Save app details**, then connect and complete provider consent. Changing app details requires reconnecting the account. Details and tokens are encrypted in the local OAuth vault. Use **Connection details & privacy** to inspect the method and saved application configuration; enter secrets in that form rather than chat.

## Drafts and sending

The assistant can prepare a local email preview containing recipients, subject, body and supported attachments. Preparing that preview does not send it or save it in your mailbox. Review and edit it in LegalWork, then use the card's save action to put it into the connected mailbox. Sending is a separate action from the card. Inspect To, Cc, Bcc, subject, body and attachments before sending.

**Allow write access** and provider consent are separate requirements. Turning the setting on does not expand an account's previously granted scopes; use **Reconnect** if it only has read permissions. Turning it off blocks LegalWork write actions but does not revoke provider-side permissions.

If a saved draft changes in Gmail or Outlook, LegalWork can require you to review the provider's version instead of sending an outdated local copy. If delivery is marked uncertain, check the mailbox before retrying. A lost response is not proof that sending failed.

## Disconnect and troubleshoot

| Situation | What to do |
| --- | --- |
| Connect is disabled | Check worker availability, the chosen connection method, Eigenwelt sign-in or saved OAuth app details. Save pending app-detail edits first. |
| Browser sign-in expired or was cancelled | Cancel the pending attempt, reconnect and keep the LegalWork panel open until completion. |
| Outlook account exists but mail is unavailable | Activate **Outlook Email** separately from **Outlook Calendar**, then test the connection. |
| Can read but cannot save or send | Enable **Allow write access**, reconnect if scopes are missing, and check organization policy. |
| Organization blocks consent | Give the administrator the provider's error and application details. |
| Connection needs refreshing | Use **Refresh**, **Test connection**, then **Reconnect** if authorization expired. |
| Attachment cannot be downloaded | Check the returned error. The mail connector's attachment-download limit is 5 MB; Outlook non-file attachment types are not supported by that download action. |
| Remove access | Select **Disconnect**. For Outlook this disconnects the shared Email and Calendar account. Review provider-side app permissions separately if you also want to revoke consent. |

Disconnecting does not delete mailbox messages, previously downloaded attachments or chat history. Mail read into an assistant task is included in that task's model context. With **Connect with Eigenwelt**, Nango manages sign-in and token renewal; LegalWork retrieves mail content directly from the provider. With your own OAuth app, LegalWork authenticates directly using that app.

## Firm-provided mail connectors

A firm can also supply a custom MCP connector. Open **Settings > Integrations > Add > Plugins**, then choose **Custom** in the catalogue to create a plugin with that connector. Use the supplied MCP address and authentication details. A Gmail or Outlook webmail address is not an MCP endpoint. Custom connectors determine their own account support and actions; check their actual tools rather than assuming the built-in connector's behavior.

Related: [Integrations](integrations.md), [Settings and privacy](settings-privacy.md), [Troubleshooting](troubleshooting.md).
