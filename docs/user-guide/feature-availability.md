# Feature availability

Use this page to distinguish core, optional and account-dependent surfaces. The [screen inventory](screens.json) is generated from the routing and visible-settings declarations of the build that packages it. The [screen map](screens.md) explains where each feature lives. A live tool or status response establishes what is enabled now.

| Capability | Availability and prerequisites |
| --- | --- |
| Chats, folder/workspace context, file outputs | LegalWork running with access to the selected project folder. Cloud sources need their own connected account. |
| Model providers and Fusion | Connected providers and eligible models; Fusion needs selected candidate models. |
| Document editors and previews | A supported file and an available file/editor surface. Format fidelity varies by editor. |
| Connected file storage | Configured connection, service reachability, provider permissions and appropriate access role. |
| Team libraries/storage and synced intake tasks | Connected firm account, supported platform capabilities, role and entitlement. |
| Local Tasks and Workflows | Local server/workspace; starting a workflow also needs an installed workflow and reachable folder. |
| Project Home, Files, Chats and sharing | Firm sharing also needs service support, membership, subscription and sharing scope. See [Projects](projects-sharing.md). |
| Native Calendar and legal deadlines | Calculated deadlines require the appropriate installed, supported skill. Sharing/subscription links require firm-service support. See [Calendar](calendar.md). |
| Scheduled assistant runs | Local computer awake and LegalWork running. A task due date alone never schedules a run. See [Scheduled tasks](scheduled-tasks.md). |
| Native Tabular Review and prompt library | Available configured review/OCR models. See [Reviews](reviews.md). |
| Wiki and saved dashboards/reports | Shared content needs appropriate access and service support. See [Wiki](wiki.md) and [Dashboards](dashboards.md). |
| Evaluations | Connected tested models and judge, benchmark tasks, and LegalWork remaining available. |
| Recorder and dictation | Desktop/native audio support, a ready transcription source and required OS permissions. Local models need downloads; optional cloud models need account/region availability and network access. |
| Meeting detection, microphone picker and overlay settings | Recorder settings; available controls and OS readiness determine support. Detection offers recording rather than starting it automatically. |
| Per-app audio capture | Supported macOS capture runtime; the UI reports unsupported systems. Windows uses system audio for call capture. |
| Voice Mode | Compatible OpenAI realtime credentials, microphone access and voice integration availability. Networked, unlike local transcription. |
| Office Add-ins installation | Desktop on macOS or Windows, installed Office apps and trusted local connection. |
| Computer Use built-in integration | This build's manifest targets macOS; needs Accessibility and Screen Recording grants. |
| Google calendar/mail or other external services | Whatever operations the enabled connector exposes under its actual scopes. A connector is not a native inbox/calendar UI. |
| Gmail and Outlook Email connectors | Follow [Email setup](email.md). Requires a reachable worker, account consent and either Eigenwelt sign-in or a configured personal OAuth app. Outlook Email and Calendar share an account but activate separately. |
| App updates | Supported installed desktop distribution; browser/dev and some package-managed environments differ. |
| UI language | English and German ship. Other existing locale tables are archival and incomplete. |

## Retained and planned features

Some code and translation entries remain for older or developer-only surfaces. The inspected Settings sidebars do not list separate Language/Appearance, Recovery, Advanced or cloud-management sections. The Language picker is reachable in Customization. Debug is developer-only; Recovery/Advanced are diagnostic entry points when deliberately exposed. Theme selection is in Customization.

Messaging/Telegram configuration code remains in the repository, but it is not rendered as a reachable settings page in this build. Do not instruct a user to open a nonexistent Messaging tab. Use an installed connector's actual supported tools when relevant.

Task due dates appear in Calendar but do not schedule an assistant run. A guide, development plan, locale key or implementation on another branch does not install a feature in the running app. When a surface is unavailable, explain that limit and identify an existing connector or workflow only if it actually provides the requested capability.

Related: [Integrations](integrations.md), [Settings](settings-privacy.md), [Troubleshooting](troubleshooting.md).
