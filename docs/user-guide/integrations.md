# Integrations

Open in LegalWork: [Connectors](legalwork://app/settings/extensions/mcp), [Plugins](legalwork://app/settings/extensions/plugins).

## Connectors, storage, skills and plugins

Open **Settings > Integrations**. Its tabs separate **Plugins**, **Skills** and **File storage**. Connectors appear in the Plugins library. A catalogue entry is an available integration, not proof it is connected.

To add a connector, press **Add**, choose **Plugins** to open the **Plugin catalogue**, then search for and select the connector, such as **Gmail** or **Outlook Email**. Follow its setup flow. Do not skip **Add** when the connector has not been added yet. To manage an existing connector, open its entry in the library. Some use browser sign-in; others need an API key, local command or remote MCP URL. A custom MCP connection can use the supported local-command or remote-server configuration. Complete authentication and check its connection status. Reload the agent when the app requests it so the new tools become available.

An MCP server publishes tools with its own access requirements. Local-command integrations run on the computer running LegalWork, so required software and credentials must exist there. A remote MCP URL connects to the external service instead of starting its program locally. A disabled connector or expired authorization can leave a card visible while its tools fail or are absent.

Plugins add OpenCode tools or hooks. Use the Plugins tab's supported installation/import flow, including the Claude-plugin bundle preview when offered. Previewing a package does not establish that every third-party component works in this runtime. Follow any reported compatibility errors. Most repeatable drafting procedures need a skill or workflow rather than a custom plugin.

## LegalMemory and firm knowledge

LegalMemory is a separate Eigenwelt knowledge index. Connect the firm's instance using its connector when available. Search its live records for matters, documents and other firm knowledge; inspect the returned source evidence. Connecting ordinary file storage does not automatically create a LegalMemory index.

A disconnected connector's historical output, old chats or runtime caches are not substitutes for the live source. If the firm has not connected LegalMemory, use the source the user identifies or the available connected storage. A failed search is not evidence that the matter does not exist everywhere.

## Google Workspace and other services

For Gmail and Outlook setup, connection methods, write permissions and troubleshooting, read [Email setup](email.md). The native catalog also includes Google Calendar, Outlook Calendar, Google Drive, OneDrive and SharePoint. Each connector has its own supported operations and write-access setting. Outlook Email and Calendar share an account but activate separately.

Connecting a calendar service lets the assistant use that service's available tools. It does not automatically import those events into LegalWork's project Calendar. Connecting a drive does not establish mail access. Check the individual connector's status and granted permissions.

## Browser and Computer Use

The built-in browser opens websites in a browser panel. Ask the assistant to open a URL and inspect the page with the browser tools. Use the returned browser target for subsequent actions. Website sign-ins, downloads and site permissions are separate from LegalWork model-provider sign-in. Inspect the returned file location after downloading.

Computer Use controls desktop applications and is configured from its integration card. The built-in desktop integration in this build targets macOS and requires Accessibility and Screen Recording permissions. Use its setup/test controls to confirm readiness. For LegalWork's own navigation, prefer the app's UI action tools so the assistant can open settings or sessions directly. Browser automation is for web content, not an assumption that LegalWork's native controls are a website.

Additional integrations, including media capabilities, depend on installed packages and their credentials. The live catalog and returned tool descriptions are authoritative for those tools.

Related: [Storage](connected-storage.md), [Skills](skills-workflows.md), [Audio](audio.md), [Feature availability](feature-availability.md).
