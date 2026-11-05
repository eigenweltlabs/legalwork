---
name: legalwork-help
description: Answer how-to questions about LegalWork using its bundled manual. Use for app features, settings, navigation, localized controls and troubleshooting.
---

# LegalWork help

For an ordinary how-to question, read the matching page with `legalwork_skill_read`, then answer. This skill and that page are normally sufficient. Use the exact package reference: `name="legalwork-help", path="references/email.md"` for Gmail or Outlook setup. Do not read the index, screen map or localization guide first when the topic is already clear.

| Question | Read |
| --- | --- |
| Personal Assistant, daily chats, custom instructions or cloud setup | [assistant.md](references/assistant.md) |
| Gmail or Outlook email | [email.md](references/email.md) |
| What is a workflow, create/run workflows or install skills | [skills-workflows.md](references/skills-workflows.md) |
| Calendar, deadlines, reminders or subscriptions | [calendar.md](references/calendar.md) |
| Transcription models, dictation shortcut, microphone or meeting detection | [recorder-settings.md](references/recorder-settings.md) |
| Record, import or edit a transcript; Voice Mode | [audio.md](references/audio.md) |
| Projects, matter details, linked folders or sharing | [projects-sharing.md](references/projects-sharing.md) |
| Chats, history, folders or remote workers | [workspaces-chats.md](references/workspaces-chats.md) |
| Model providers, Fusion, OCR or JEV | [models-fusion.md](references/models-fusion.md) |
| Tabular Review or review prompt sets | [reviews.md](references/reviews.md) |
| Schedules that run the assistant | [scheduled-tasks.md](references/scheduled-tasks.md) |
| Tasks, inbox or notifications | [tasks-intake.md](references/tasks-intake.md) |
| Files, document editors or saving outputs | [files-documents.md](references/files-documents.md) |
| Cloud drives or network storage | [connected-storage.md](references/connected-storage.md) |
| Connectors, plugins, browser or Computer Use | [integrations.md](references/integrations.md) |
| Wiki | [wiki.md](references/wiki.md) |
| Saved dashboards or reports | [dashboards.md](references/dashboards.md) |
| Evaluations | [evaluations.md](references/evaluations.md) |
| Word, Excel or PowerPoint add-ins | [office-addins.md](references/office-addins.md) |
| Account, language, appearance, permissions, secrets or privacy | [settings-privacy.md](references/settings-privacy.md) |
| Setup | [getting-started.md](references/getting-started.md) |
| Errors, updates or recovery | [troubleshooting.md](references/troubleshooting.md) |

Answer the question directly and briefly. For setup, give the ordinary path and necessary prerequisites; explain alternative methods only if relevant or requested. Reuse the page's `legalwork://app/...` links as natural labels, for example [Connectors](legalwork://app/settings/extensions/mcp). Clicking one navigates inside LegalWork. Do not invent destinations or turn an explanation into a settings change.

A how-to question does not require checking the user's account, installed integrations or screen. Do not take UI snapshots, list files, call connectors or inspect account status just to explain documented steps. Read another page only if the first leaves a specific part of the question unanswered. Use live tools when the user asks you to perform an action, diagnose a reported failure, or check their actual current configuration. The current app language may already be in conversation context. If unknown, use the manual's English labels without making a snapshot just to discover it.

For an exact translated control that you cannot establish from existing context, use the [localization guide](references/localization.md) and the read-only label helper. The complete [i18n reference](references/i18n.json) contains all existing locale tables; avoid reading that entire file. Run the helper through `legalwork_shell` with this loaded skill's returned mount path and `skills` argument, following the shell tool contract. For example, pass the helper path followed by `de settings.tab_ai`. Do not browse folders to discover a resource already listed in the loaded package.

For broad feature inventories or an unclear destination, use the [manual index](references/index.md), [screen map](references/screens.md), [generated screen inventory](references/screens.json) or [availability guide](references/feature-availability.md) as needed. These describe this app version. Platform and account prerequisites do not require a live check for a general explanation. If the manual does not establish a behavior, state that limit. This skill is app help, not legal advice or a source of matter facts.
