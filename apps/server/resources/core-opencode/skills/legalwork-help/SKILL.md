---
name: legalwork-help
description: Answer how-to questions about LegalWork using its bundled manual. Use for app features, settings, navigation, localized controls and troubleshooting.
---

# LegalWork help

For an action request to set up any website login, use legalwork_browser_request_password directly with the user-supplied website_url or a known catalogue provider. Ask for the sign-in URL if missing. The existing secure card checks saved logins. No manual lookup is needed before the card.

For an ordinary how-to question, read the matching page with `legalwork_skill_read`, then answer. If the result has `nextOffset`, continue at that offset until the relevant section is complete. This skill and that page are normally sufficient. Use the exact package reference: `name="legalwork-help", path="references/email.md"` for Gmail or Outlook setup. Do not read the index, screen map or localization guide first when the topic is already clear.

| Question | Read |
| --- | --- |
| Personal Assistant, proactive updates, scratchpad, morning briefings, daily chats or custom instructions | [assistant.md](references/assistant.md) |
| Email reader, meeting invitations, ICS previews or reviewed invitation replies, shared Integrations accounts, retained local copies or account migration, Inbox, Drafts, Outbox, iCloud or IMAP/SMTP, Gmail or Outlook, direct Microsoft sign-in, or an OAuth app override | [email.md](references/email.md) |
| S/MIME, signed or encrypted email, signature/certificate verification, unavailable decryption keys, RPMSG or Microsoft protected-mail limitations | [email.md](references/email.md) |
| Fastmail, native JMAP availability, on-premises Exchange, EWS or IMAP/SMTP protocol limitations | [email.md](references/email.md) |
| Proton Mail Bridge availability, paid-plan or installed-Bridge prerequisites, local certificates or Bridge qualification limits | [email.md](references/email.md) |
| Mail diagnostics, safe mail support export, queued/uncertain action counts or local download incident reports | [email.md](references/email.md) |
| Workflows, Review prompts, Skills tab, create/run workflows or install skills | [skills-workflows.md](references/skills-workflows.md) |
| Calendar, shared Outlook calendar consent or delegate permissions, Calendar write access, deadlines, reminders or subscriptions | [calendar.md](references/calendar.md) |
| Transcription models, recording setup, dictation shortcut, meeting detection or Meeting Summarisation | [recorder-settings.md](references/recorder-settings.md) |
| Record, import, edit or summarize a transcript; speaker names; Voice Mode | [audio.md](references/audio.md) |
| Projects, matter details, linked folders or sharing | [projects-sharing.md](references/projects-sharing.md) |
| Chats, history, folders or remote workers | [workspaces-chats.md](references/workspaces-chats.md) |
| Model providers, Fusion, OCR or JEV | [models-fusion.md](references/models-fusion.md) |
| Tabular Review or review prompt sets | [reviews.md](references/reviews.md) |
| Scheduled email, Send later, scheduled Outbox items, rescheduling, Snoozed, snoozing conversations, local mail rules, new-arrival conditions, rule readiness or activity, daylight-saving time, local execution guarantees, Email on multiple devices or hosted mail availability | [email.md](references/email.md) |
| Schedules that run the assistant | [scheduled-tasks.md](references/scheduled-tasks.md) |
| Tasks, inbox or notifications | [tasks-intake.md](references/tasks-intake.md) |
| Files, document editors or saving outputs | [files-documents.md](references/files-documents.md) |
| Cloud drives or network storage | [connected-storage.md](references/connected-storage.md) |
| Website logins, the general legal-research skill, research databases, country suggestions, beck-online, Lexis, Westlaw, CourtListener setup or learned website experience | [integrations.md](references/integrations.md) |
| Integration categories, installed connections, connector detail pages, multiple named connections, browser or Computer Use | [integrations.md](references/integrations.md) |
| Wiki, Legal Research / Rechtliche Recherche, research starter selection, jurisdiction/area browsing, proposed folders, consent to file findings or staged research contributions | [wiki.md](references/wiki.md) |
| Save, copy, rename, export or reopen dashboards and reports | [dashboards.md](references/dashboards.md) |
| Evaluations | [evaluations.md](references/evaluations.md) |
| Word, Excel or PowerPoint add-ins | [office-addins.md](references/office-addins.md) |
| Browser passwords, inline sign-in card, automatic password filling, account, language, appearance, permissions, secrets or privacy | [settings-privacy.md](references/settings-privacy.md) |
| Setup | [getting-started.md](references/getting-started.md) |
| Errors, updates or recovery | [troubleshooting.md](references/troubleshooting.md) |

Answer the question directly and briefly. For setup, give the ordinary path and necessary prerequisites; explain alternative methods only if relevant or requested. Reuse the page's `legalwork://app/...` links as natural labels, for example [Connectors](legalwork://app/settings/extensions/mcp). Clicking one navigates inside LegalWork. Do not invent destinations or turn an explanation into a settings change.

A how-to question does not require checking the user's account, installed integrations or screen. Do not take UI snapshots, list files, call connectors or inspect account status just to explain documented steps. Read another page only if the first leaves a specific part of the question unanswered. Use live tools when the user asks you to perform an action, diagnose a reported failure, or check their actual current configuration. The current app language may already be in conversation context. If unknown, use the manual's English labels without making a snapshot just to discover it.

For an exact translated control that you cannot establish from existing context, use the [localization guide](references/localization.md) and the read-only label helper. The complete [i18n reference](references/i18n.json) contains all existing locale tables; avoid reading that entire file. Run the helper through `legalwork_shell` with this loaded skill's returned mount path and `skills` argument, following the shell tool contract. For example, pass the helper path followed by `de settings.tab_ai`. Do not browse folders to discover a resource already listed in the loaded package.

For broad feature inventories or an unclear destination, use the [manual index](references/index.md), [screen map](references/screens.md), [generated screen inventory](references/screens.json) or [availability guide](references/feature-availability.md) as needed. These describe this app version. Platform and account prerequisites do not require a live check for a general explanation. If the manual does not establish a behavior, state that limit. This skill is app help, not legal advice or a source of matter facts.
