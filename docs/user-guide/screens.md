# Find a screen and understand what it does

Use this map when you know what you want to do but not where to start. The assistant can check the bundled [screen inventory](screens.json) for this build's routes and settings, then confirm access in the live app. A documented optional screen does not imply it is installed or enabled.

## Main navigation and project pages

| Screen | What it is for | Guide |
| --- | --- | --- |
| Welcome | First-run account, folder, audio and integration setup | [Getting started](getting-started.md) |
| Save logins for the in-app browser | Save your own logins for legal research websites so you and your agent can use them | [Research databases](integrations.md#research-databases) |
| Home / New Chat | Start an assistant conversation, attach inputs and choose a model | [Chats](workspaces-chats.md) |
| Chat and document tabs, View > Select Tab | Continue work, switch tabs with Cmd/Ctrl+1–9, respond to approvals, inspect files and use the terminal | [Chats](workspaces-chats.md), [Files](files-documents.md) |
| Shield icon in the top-right of a chat | Choose the chat's sandbox and network settings, restore inheritance or retry a status check | [Sandboxing](settings-privacy.md#sandboxing) |
| Message queue above the composer | Edit or reorder pending messages; use Steer to send one at the next step without stopping the current work | [Steer with a queued message](workspaces-chats.md#steer-with-a-queued-message) |
| Sign-in details needed card | Save a missing website login directly in chat and let the browser task continue | [Browser passwords](settings-privacy.md#browser-passwords) |
| Manage saved login | Edit an existing account and use Add URL to manage its starting pages and sign-in websites | [Saved login URLs](integrations.md#add-urls-to-an-existing-login) |
| Fill saved login | Choose a saved account from a browser login field and fill its username and password | [Browser passwords](settings-privacy.md#browser-passwords) |
| Projects | Select the matter or working context from the project catalog | [Projects](projects-sharing.md) |
| Back Office > Create | Create a record with the same short form used in project and relation pickers | [Back Office](back-office.md) |
| Back Office > Data model > object > Settings | Choose which fields appear immediately in short creation forms | [Short forms](back-office.md#choose-the-fields-in-short-forms) |
| Back Office > record > History | Inspect changes, compare previous values, check attribution and download signed history | [Back Office history](back-office.md#history-and-verification) |
| Project Home | Link matters, clients, people or organisations directly; see clients via linked matters, notes and upcoming deadlines | [Projects](projects-sharing.md) |
| Project Home / Create project > More… | Fill empty template fields, link additional record types or add a simple project field | [Projects](projects-sharing.md) |
| Project Home / Create project > Customize fields | Customize field labels, record roles, selection rules and templates | [Projects](projects-sharing.md) |
| Project Files | Local files and linked storage, with import and document panels | [Files](files-documents.md), [Storage](connected-storage.md) |
| Project Chats | Conversations belonging to one project | [Chats](workspaces-chats.md) |
| Tasks / Inbox and Project Tasks | Work with an owner, status, due date and attachments | [Tasks](tasks-intake.md) |
| Calendar and Project Calendar | See tasks, deadlines and connected events; scroll through weeks and read event details | [Calendar](calendar.md) |
| Scheduled | Run a prompt at a chosen time or repeatedly | [Scheduled tasks](scheduled-tasks.md) |
| Workflows | Maintain workflows, review prompt sets and skills | [Workflows](skills-workflows.md) |
| Project Tabular Review | Ask the same questions across documents and inspect cited answers | [Tabular Review](reviews.md) |
| Project Dashboards and dashboard files | Save previews, copy to projects or wikis, rename, export and reopen dashboards | [Dashboards](dashboards.md) |
| Wiki, Settings > Agent access, source file tabs | Maintain reusable knowledge; control agent approval; open source documents in separate viewer tabs | [Wiki](wiki.md) |
| Wiki: Legal Research / Rechtliche Recherche, starter picker, area and jurisdiction indexes | Create a research wiki automatically or through Add wiki; automatically prepare legal findings and sources; review drafts or allow background filing | [Legal research knowledge base](wiki.md#your-legal-research-knowledge-base) |
| Recorder / Recordings | Capture audio, import recordings and inspect transcripts | [Audio](audio.md) |
| Evaluations | Compare model performance against benchmark tasks and judging criteria | [Evaluations](evaluations.md) |

Opening a project or changing a filter can reveal items hidden in an aggregate list.

## Settings

| Screen | Questions it answers | Guide |
| --- | --- | --- |
| Overview | Where is the setting I need? | [Settings](settings-privacy.md) |
| Account | Which firm am I signed into? What plan, models and usage are available? | [Settings](settings-privacy.md) |
| AI Providers | How do I connect a chat model, set up Fusion, OCR or JEV? | [Models](models-fusion.md) |
| Tabular Review | Which inference mode, models and probability threshold apply to new reviews? | [Tabular Review](reviews.md) |
| Recorder: Models | Which transcription source, language and downloaded model should I use? | [Recorder settings](recorder-settings.md) |
| Recorder: Dictate anywhere | How do I set the shortcut, microphone, activation mode and startup behavior? | [Recorder settings](recorder-settings.md) |
| Recorder: Meetings | How do meeting detection, Meeting Summarisation, mini-bar visibility and screen-share visibility work? | [Recorder settings](recorder-settings.md) |
| Office Add-ins | How do I install and connect the Office sidebars? | [Office Add-ins](office-addins.md) |
| Integrations: category catalogue and connector details | How do I connect an external service, sign in directly with Microsoft or manage an OAuth app override? | [Integrations](integrations.md), [Email](email.md) |
| Integrations: Austrian RIS | How do I enable Austrian legal research, test access or disable local API tools? | [Austrian RIS](integrations.md#austrian-ris) |
| Integrations: Files & storage | Where are cloud drives and network shares configured? | [Storage](connected-storage.md) |
| Workflows: Skills | How do I install, inspect or share reusable instructions? | [Workflows](skills-workflows.md), [Integrations](integrations.md) |
| Personalisation | Where do writing instructions, tone and legacy memory controls live? | [Settings](settings-privacy.md) |
| Notifications | Which task events produce notifications or badges? | [Tasks](tasks-intake.md) |
| Tool Permissions | What can the assistant do automatically? | [Settings](settings-privacy.md) |
| Customization | How do I change language, appearance and project defaults? | [Settings](settings-privacy.md), [Localization](localization.md) |
| Secrets | How do I save browser passwords, use automatic filling and apply environment changes? | [Settings](settings-privacy.md) |
| Privacy | How do usage analytics and online catalog updates work? | [Settings](settings-privacy.md) |
| Unsaved changes before closing or restarting | Save or discard pending workflow and file edits, or open an affected file | [Unsaved changes](settings-privacy.md#unsaved-changes-when-closing-or-restarting) |
| Updates | Which version/channel is running, and how do I install an update? | [Troubleshooting](troubleshooting.md) |
| Workspace Permissions | Which folders can this workspace access? | [Settings](settings-privacy.md) |
| Advanced / Recovery / Debug | How do I inspect or repair the runtime when those diagnostic screens are exposed? | [Troubleshooting](troubleshooting.md) |

## Choose the right kind of item

A **project** holds a matter's context. A **chat** is a conversation in that context. A **task** tracks work to do. A **workflow** describes how to perform a repeatable task. A **calendar deadline** records a date requiring attention. A **scheduled task** starts an assistant run. A **review** stores answers across documents. A **wiki** holds reusable knowledge. Saving one does not automatically create the others.
