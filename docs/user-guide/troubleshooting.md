# Troubleshooting

Open in LegalWork: [Updates](legalwork://app/settings/updates), [AI Providers](legalwork://app/settings/ai).

Start with the exact error, current workspace, platform and action that failed. Check whether the failure is in the app UI, its worker, a model provider or a connected service. A successful connection test for one does not test the others.

After an engine upgrade, LegalWork copies your saved chat history into the new engine database before making chats available. It keeps the original database and a separate history backup. Development builds migrate their own saved development profile; they do not import the installed app's history. If an upgrade reports a history migration error or existing chats cannot be found, keep the profile intact and export diagnostics. Resetting your profile is not required to recover the saved chats.

| Symptom | What to check |
| --- | --- |
| No model available | Connect a provider in AI Providers; check disabled-provider filters, the account's available models, key source and any provider error. |
| New project or wiki cannot start a task | Read the project setup error. Retry setup after resolving it; the project must publish its engine configuration before accepting a task. |
| Project says its settings cannot be accessed or updated | Reconnect its drive or cloud folder and make sure LegalWork can write to that project's hidden `.opencode` folder. Then click **Refresh** in the project notice. Other projects remain available; there is no need to reset the app or approve project automation. |
| Message delivery is unconfirmed or paused | Inspect the linked chat before retrying. Resolve the displayed cause, then resume the queued message explicitly. A lost response does not prove the message was rejected. |
| Older chat reports missing migration data | Keep the recovery copies and contact support. Do not delete the app database or reset permissions to bypass the recovery error. |
| Model request fails | Read the provider's authentication, quota, rate-limit or context-size error. Check the selected model/account and retry when appropriate; reconnecting storage will not fix a provider quota. |
| File cannot be found or accessed | Confirm the workspace/worker and path. Check Permissions, remote-worker role, and source/provider permissions. An attachment in another workspace may not be present here. |
| Connector card is visible but tools are absent | Complete sign-in, enable/connect the integration, check its status and accept any required engine reload. Verify credentials on the worker that runs it. |
| Gmail or Outlook cannot connect or is unavailable in chat | Check [Email setup](email.md) for build availability, local-project access, browser sign-in, administrator consent and draft/send permissions. A Drive connection does not grant mailbox access. |
| Newly saved skill is not offered | Check Workflows > Skills or the Workflows library, the intended scope and the reload prompt. Loose files outside the library are not a library installation. |
| Connected file edited but source unchanged | Local saves affect the working copy. Use Save to the named connection and inspect any permission or conflict error. Preserve the local draft. |
| Storage search finds nothing | Check root/folder, search scope and pagination. Filename search is not guaranteed full-text search. Try the known folder and confirm the connector is live. |
| Task or workflow missing | Clear filters, select the intended Local/Team view, check sign-in/sync status and role. Ordinary tasks and benchmark tasks are separate lists. |
| Recording cannot start | Install/select a transcription model, choose an available audio source and check OS microphone/capture permissions. |
| Dictation does not insert | Check the target cursor, shortcut readiness and Accessibility/Input Monitoring on macOS. Recover failed dictations from Recorder history. |
| Office sidebar cannot connect | Keep LegalWork running, verify add-in/certificate/listener status in Office Add-ins, and fully restart Office after installation. |
| Remote worker cannot connect | Check the returned URL and credential, reachability, host availability and role. The browser client cannot repair a stopped remote machine by itself. |
| Button names differ | Confirm the display language in Customization and look up the exact key/label in the bundled i18n reference. |
| Calendar or another documented screen is missing | Check this build's [screen inventory](screens.json) and [screen map](screens.md). Newer-screen instructions are conditional; account access and platform can further restrict them. |
| Dated task missing from Calendar | Confirm the task has a date, the chosen project, active filters, task-sharing scope and current sync status. A task and a deadline are separate records. |
| Scheduled run did not happen | Check active/paused state, time zone, Next run, runtime availability and whether the selected chat is busy. LegalWork must be open and the computer awake. Inspect run history and the linked chat. |
| Review cells are empty, stale or failed | Inspect document preparation and the review's actual mode/models. Continue unfinished work or retry failed cells; do not treat uncertainty as Not found. |
| Cloud transcription is unavailable | Check the selected transcription source, connection, firm model permission and region. An installed local model is a separate option. |
| Meeting detection offers nothing | Check supported OS/app, visible meeting tab and permissions. Start recording manually if detection is unavailable. |
| Shared project or wiki is not current | Inspect sync/access status and pending conflict decisions. Offline local changes are not proof of a completed upload. |

## Reload and restart

Configuration changes can require an engine reload. Use the reload prompt when offered and account for active tasks. Restarting a worker is different from switching chats or reloading the browser. A full application restart may be required after OS permission changes or an installed update. Avoid resetting configuration as the first response to an ordinary provider error.

## Updates

Open **Settings > Updates** to see the current version, release channel and last check. Use the available check, download and install/restart controls. Background checking and automatic-download preferences are separate. A check reporting an error or unsupported runtime does not mean the app is up to date. Active work can block or warn before restart. Browser/development/package-manager environments may not support the same updater as an installed desktop build.

## Diagnostics and recovery

In the desktop app, open **Settings > Updates** for two separate support exports. **Collect support logs** saves the existing `.txt` report with runtime details and log excerpts. Logs can contain filenames or content from an error; review that report before sharing it.

For a detailed report with chat message text removed, find **Detailed support export** and set **Days** (default **7**, from **1** to **365**). This selects chats active during that period. Click **Export diagnostic traces**, choose where to save `legalwork-diagnostics-….json`, then review it before attaching it to your support request. This second export includes application logs, runtime status, execution events, tool names, arguments, results, complete errors, model details, token usage and timestamps. Original identifiers connect chats, child agents, messages and tool calls. Message records contain technical metadata; user and assistant message bodies, reasoning text, chat titles, summaries and attachment bytes are omitted. Credentials and exact copies of retained message bodies are redacted from traces where detected.

This report still contains file paths, commands and potentially document excerpts or paraphrases inside tool results and logs. It is not an anonymous or content-free report. Review before sharing; secret redaction is best effort. It covers up to 100 chats active during the chosen period, their recent message and tool metadata, and dated execution events within that period. Each engine section includes up to 20,000 records. Application logs include tails of up to ten log files: dated entries are filtered to the selected period, and stack traces stay with their preceding entry. Undated log files use their last modification date. Current runtime snapshots, session metadata and events without timestamps can include context outside the selected period. Individual strings and total trace text are capped, and the report marks truncation. An export does not upload anything or change your chats. The local service must be running. Missing sources are recorded in the file. Events that were never recorded cannot be reconstructed; reproduce the problem and export again if support needs a newer trace.

Advanced/Debug surfaces provide runtime health and diagnostics when exposed. Recovery can offer configuration reset, cache repair or leftover-container cleanup, but it is not a normal navigation item in this build. These actions have different effects; use the actual diagnostic surface and read its explanation before applying one. Preserve user files and configuration needed for recovery.

When reporting a problem, include the app version, operating system, selected local/remote workspace type, steps, exact error and whether it reproduces. Exclude credentials and unrelated matter content. This manual is not a record of your current runtime status.

Related: [Settings](settings-privacy.md), [Feature availability](feature-availability.md), [Localization](localization.md).
