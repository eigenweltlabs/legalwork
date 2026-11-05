# Settings and privacy

Open in LegalWork: [Settings](legalwork://app/settings), [Customization](legalwork://app/settings/shell), [Privacy](legalwork://app/settings/preferences).

Open Settings from the app's settings action or native app menu. The overview links to the active sections. The selected workspace matters for folder permissions; many other settings apply globally.

| Section | Purpose |
| --- | --- |
| Account | Eigenwelt firm sign-in, account/organization context, plan, usage and billing access. |
| AI Providers | Connect, inspect, replace or disconnect model credentials and configure model-related options. |
| Tabular Review | Default review mode, models and minimum answer probability for new reviews. |
| Recorder | Transcription models/source, language, dictation and meeting settings. See [Recorder settings](recorder-settings.md). |
| Office Add-ins | Install/manage the local Word, Excel and PowerPoint add-ins on supported desktops. |
| Integrations | Connectors, file storage, skills and plugins, including team library views when available. |
| Personalisation | Custom instruction additions, response personality and deletion of legacy local memories. |
| Notifications | Task arrivals, due/overdue reminders, notification scope and system/badge delivery. |
| Tool Permissions | Which tool actions may proceed automatically or require approval, across workspaces. |
| Customization | App language, task suggestions and display of reasoning. Appearance, project defaults, branding and new-window choices depend on the build. |
| Secrets | Environment variables for services and integrations. |
| Privacy | Usage analytics and online model-catalog updates. |
| Updates | Version/channel, update checks, download and install/restart controls. |
| Permissions | Authorized folders and file access for the selected workspace. |

**Evaluations** and **Workflows** have main-sidebar entries. The separate Language/Appearance and Recovery routes are not normal sidebar sections in this build. Advanced and Debug screens are diagnostic surfaces; Debug is shown in developer mode. Old translation keys for cloud sections, theme controls or other screens do not establish a visible menu item.

## Account and firm-managed controls

Open **Account** to sign in, inspect the current firm, plan and usage, and open the available account/billing management action. A saved account can be reconnecting rather than fully disconnected. Use the displayed error and refresh controls before entering credentials again. If sign-out reports unsent project changes, resolve them first.

Firm policies can supply models, connectors or settings and can lock individual controls. A disabled control with a firm-policy note requires an administrator change; replacing a personal key does not override it. Signing into the firm, connecting a personal model provider and signing into file storage are separate operations.

## Access and secrets

Authorizing a folder allows the assistant to access that location under its rules. Tool Permissions governs actions, not OS microphone, Accessibility or Screen Recording grants. Firm roles and provider permissions can impose additional restrictions. An approval in one layer does not override the others.

Enter API keys and passwords in the relevant connection/Secrets form. Local connection credentials belong to this LegalWork installation; team-managed connections have their own access rules. Do not expose secrets in screenshots, chat examples or diagnostic reports. Changing environment/configuration can require an engine reload; wait for active work or use the app's offered controls.

In **Secrets**, add the exact environment-variable name expected by the integration and its value, then save. **Saved, not in use yet** means the running engine still needs the offered apply/reload action. Editing a stored value and applying it are distinct steps. If you use a separately operated LegalWork server, configure its integrations on that server.

In **Tool Permissions**, inspect the displayed rule for the operation before changing it. Allowing a tool to run automatically can affect later chats as well as the current one. In workspace **Permissions**, add/remove the intended folder grant and check the selected workspace. Neither setting replaces provider consent or OS access grants.

## Personalisation and memory

Use **Personalisation > System prompt additions** to enter persistent writing instructions, then **Save**. These apply to chats on the current host. Choose a personality such as Default, Pragmatic or Professional if useful; individual models can follow tone differently. Project-specific instructions belong in the project's personalisation controls when available.

The Memory section can contain cleanup controls for legacy local memories. The app no longer creates local memories; their presence in settings does not promise automatic learning from every chat. **Delete local memories** permanently removes the indicated host/workspace memory blocks, not chat history, workspace documents, Wiki pages or a firm's LegalMemory index. For matter facts, use live sources.

## Customization

Change the display language in **Customization**. Use the appearance selector to choose light, dark or system appearance. Task suggestions controls starter suggestions; showing model reasoning changes what is displayed, not the model's reasoning budget.

**Projects** offers defaults for matter fields and a new-window preference to ask, open empty or copy the current context. Project defaults apply when creating a project; they do not overwrite every existing matter.

## Privacy and data flow

Workspace files and local processing remain on the computer running LegalWork, but provider requests and connector actions can transmit task data to the chosen service. Local transcription runs on-device; cloud transcription and Voice Mode transmit audio to their selected services. Shared projects, wiki sharing and published calendar feeds also copy the chosen data to the firm's service. Ordinary connected storage is not automatically ingested into a knowledge index.

Official builds can send content-free usage telemetry when enabled. **Settings > Privacy** controls the analytics preference; development builds do not send it. Where offered, online model-catalog updates control refreshing provider/model metadata, not downloading a local transcription model. These settings are separate from network access needed for a provider or connector. App-hiding controls live under Recorder > Meetings. They affect visibility, not provider data handling.

Related: [Localization](localization.md), [Audio](audio.md), [Troubleshooting](troubleshooting.md).
