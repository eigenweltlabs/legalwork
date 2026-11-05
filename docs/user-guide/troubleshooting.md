# Troubleshooting

Open in LegalWork: [Updates](legalwork://app/settings/updates), [AI Providers](legalwork://app/settings/ai).

Start with the exact error, current workspace, platform and action that failed. Check whether the failure is in the app UI, its worker, a model provider or a connected service. A successful connection test for one does not test the others.

| Symptom | What to check |
| --- | --- |
| No model available | Connect a provider in AI Providers; check disabled-provider filters, the account's available models, key source and any provider error. |
| Model request fails | Read the provider's authentication, quota, rate-limit or context-size error. Check the selected model/account and retry when appropriate; reconnecting storage will not fix a provider quota. |
| File cannot be found or accessed | Confirm the project and path. Check folder Permissions, firm role and source/provider permissions. An attachment in another workspace may not be present here. |
| Connector card is visible but tools are absent | Complete sign-in, enable/connect the integration, check its status and accept any required engine reload. Verify credentials in the LegalWork installation running it. |
| Gmail or Outlook cannot connect or is unavailable in chat | Check [Email setup](email.md) for build availability, local-project access, browser sign-in, administrator consent and draft/send permissions. A Drive connection does not grant mailbox access. |
| Newly saved skill is not offered | Check Integrations > Skills or the Workflows library, the intended scope and the reload prompt. Loose files outside the library are not a library installation. |
| Connected file edited but source unchanged | Local saves affect the working copy. Use Save to the named connection and inspect any permission or conflict error. Preserve the local draft. |
| Storage search finds nothing | Check root/folder, search scope and pagination. Filename search is not guaranteed full-text search. Try the known folder and confirm the connector is live. |
| Task or workflow missing | Clear filters, select the intended Local/Team view, check sign-in/sync status and role. Ordinary tasks and benchmark tasks are separate lists. |
| Recording cannot start | Install/select a transcription model, choose an available audio source and check OS microphone/capture permissions. |
| Dictation does not insert | Check the target cursor, shortcut readiness and Accessibility/Input Monitoring on macOS. Recover failed dictations from Recorder history. |
| Office sidebar cannot connect | Keep LegalWork running, verify add-in/certificate/listener status in Office Add-ins, and fully restart Office after installation. |
| A separately operated LegalWork server cannot connect | Check its URL, access token and availability. A browser client cannot start a stopped server. |
| Button names differ | Confirm the display language in Customization and look up the exact key/label in the bundled i18n reference. |
| Calendar or another documented screen is missing | Check this build's [screen inventory](screens.json) and [screen map](screens.md). Newer-screen instructions are conditional; account access and platform can further restrict them. |
| Dated task missing from Calendar | Confirm the task has a date, the chosen project, active filters, task-sharing scope and current sync status. A task and a deadline are separate records. |
| Scheduled run did not happen | Check active/paused state, time zone, Next run, runtime availability and whether the selected chat is busy. LegalWork must be open and the computer awake. Inspect run history and the linked chat. |
| Review cells are empty, stale or failed | Inspect document preparation and the review's actual mode/models. Continue unfinished work or retry failed cells; do not treat uncertainty as Not found. |
| Cloud transcription is unavailable | Check the selected transcription source, connection, firm model permission and region. An installed local model is a separate option. |
| Meeting detection offers nothing | Check supported OS/app, visible meeting tab and permissions. Start recording manually if detection is unavailable. |
| Shared project or wiki is not current | Inspect sync/access status and pending conflict decisions. Offline local changes are not proof of a completed upload. |

## Reload and restart

Configuration changes can require an engine reload. Use the reload prompt when offered and account for active tasks. Restarting the LegalWork server is different from switching chats or reloading the browser. A full application restart may be required after OS permission changes or an installed update. Avoid resetting configuration as the first response to an ordinary provider error.

## Updates

Open **Settings > Updates** to see the current version, release channel and last check. Use the available check, download and install/restart controls. Background checking and automatic-download preferences are separate. A check reporting an error or unsupported runtime does not mean the app is up to date. Active work can block or warn before restart. Browser/development/package-manager environments may not support the same updater as an installed desktop build.

## Diagnostics and recovery

Advanced/Debug surfaces provide runtime health and diagnostics when exposed. Recovery can offer configuration reset, cache repair or leftover-container cleanup, but it is not a normal navigation item in this build. These actions have different effects; use the actual diagnostic surface and read its explanation before applying one. Preserve user files and configuration needed for recovery.

When reporting a problem, include the app version, operating system, selected project and connection type, steps, exact error and whether it reproduces. Exclude credentials and unrelated matter content. This manual is not a record of your current runtime status.

Related: [Settings](settings-privacy.md), [Feature availability](feature-availability.md), [Localization](localization.md).
