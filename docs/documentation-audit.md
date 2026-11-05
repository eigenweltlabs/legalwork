# Documentation audit

The manual targets current development source `9c278ff02` (26 October 2026). It is bundled into the same server build as the app. The help implementation preserves native review skills, shared workflows, project reminders and provider-retry hooks.

## Structure and coverage

The 25 topic/navigation pages cover main navigation, project pages, Settings, workflows, calendar, recorder, email and supporting features. `screens.json` is generated from the current router and visible-settings declarations. Unknown routes or settings fail generation until assigned a guide. This inventories navigation, not every modal or account-dependent operation.

The manual describes the bundled app version directly. Platform, account and permission prerequisites remain explicit. Gmail and Outlook instructions come from the current `connector-config.tsx`, connector definitions, write settings and local draft delivery implementation. Audio import is documented as requiring local transcription.

## Coverage map

Paths below are repository-relative implementation references for maintainers. The linked pages are the packaged user documentation.

| App area | Evidence inspected | Manual coverage |
| --- | --- | --- |
| Welcome and first-run setup | `apps/app/src/react-app/domains/onboarding/`, `shell/welcome-route.tsx` | [Getting started](user-guide/getting-started.md) |
| Folder/workspace creation and remote workers | `domains/workspace/`, `shell/workspace-routes.ts`, `shell/route-workspaces.ts` | [Workspaces and chats](user-guide/workspaces-chats.md) |
| Chat lifecycle, grouping, search, queue, tabs and terminal | `domains/session/sidebar/`, `session/control/session-control-actions.ts`, `session/surface/composer/`, `shell/use-shell-shortcuts.ts` | [Workspaces and chats](user-guide/workspaces-chats.md) |
| Provider setup, model picker and Fusion | `domains/connections/provider-auth/`, `session/modals/model-picker-modal.tsx`, `session/fusion/`, `settings/pages/ai-view.tsx` | [Models and Fusion](user-guide/models-fusion.md) |
| Memory Drive and artifact editors | `session/panel/`, `session/artifacts/`, bundled `docx-edit` and `pdf-tools` | [Files and editors](user-guide/files-documents.md) |
| File storage, cloud OAuth and team roots | `settings/pages/file-storage-view.tsx`, `storage-providers.ts`, `apps/server/src/file-storage/`, `docs/file-storage.md`, `docs/team-storage.md` | [Connected storage](user-guide/connected-storage.md) |
| Skills, workflow editors/resources, templates and sharing | `settings/pages/skills-view.tsx`, `workflows-view.tsx`, `workflow-editor-panel.tsx`, `workflow-resource-editor-panel.tsx`, `apps/server/src/opencode-plugins/legalwork-skill-tools.ts` | [Skills and workflows](user-guide/skills-workflows.md) |
| MCP, plugins, team library, browser and Computer Use | `settings/pages/extensions-view.tsx`, `mcp-view.tsx`, `plugins-view.tsx`, `apps/app/src/app/extensions.ts`, `apps/desktop/electron/browser-automation-broker.mjs` | [Integrations](user-guide/integrations.md) |
| LegalMemory and connected firm knowledge | `session/panel/legalmemory-files-panel.tsx`, `apps/server/src/opencode-plugins/legalwork-legalmemory-knowledge.ts` | [Integrations](user-guide/integrations.md) |
| Gmail and Outlook onboarding | `settings/connector-config.tsx`, `connector-write-settings.tsx`, `packages/types/src/connectors.ts`, `apps/server/src/connectors/` | [Email setup](user-guide/email.md) |
| Local/synced tasks, intake, run handoff, trash and notifications | `domains/tasks/`, `apps/server/src/opencode-plugins/legalwork-task-tools.ts`, `settings/pages/notifications-view.tsx` | [Tasks and intake](user-guide/tasks-intake.md) |
| Benchmark task catalog, imports, runs, arms, judge and analytics | `domains/benchmark/`, `shell/evals-route.tsx`, bundled `benchmark-task` | [Evaluations](user-guide/evaluations.md) |
| Recorder, local models, dictation and Voice Mode | `domains/recorder/`, `session/voice/`, `settings/pages/recorder-view.tsx`, `docs/system-wide-dictation.md` | [Audio](user-guide/audio.md) |
| Word, Excel and PowerPoint live add-ins | `settings/pages/office-addins-view.tsx`, `apps/server/src/opencode-plugins/legalwork-{word,excel,powerpoint}-tools.ts`, `docs/word-addin.md` | [Office Add-ins](user-guide/office-addins.md) |
| Every visible global/workspace settings category | `settings/shell/settings-page.tsx`, `settings/pages/general-view.tsx`, `shell/settings-route.tsx` | [Settings and privacy](user-guide/settings-privacy.md) |
| Updates, diagnostics and recovery | `settings/pages/updates-view.tsx`, `advanced-view.tsx`, `recovery-view.tsx`, `debug-view.tsx` | [Troubleshooting](user-guide/troubleshooting.md) |
| Language resolution and exact button/UI labels | `apps/app/src/i18n/index.ts`, every `locales/*.ts`, `settings/appearance/language-section.tsx` | [Localization](user-guide/localization.md), bundled `references/i18n.json` |
| Hidden/legacy routes and planned features | Current settings routing/visibility, extension platform manifests, source inventory | [Feature availability](user-guide/feature-availability.md) |


## Localization and packaging

The generated reference includes every runtime-exported key/value in all 11 locale files, including shared project-template strings. English and German are selectable; nine archived tables are marked unshipped. Missing translations remain missing. The full reference and its runtime module are generated during builds and ignored by Git. The lookup script runs from the seeded workspace without the source repository or network.

The `legalwork-help` skill is embedded in `CORE_OPENCODE_FILES`, seeded/refreshed through `ensureWorkspaceFiles`, and named by the fixed capabilities prompt. It loads only the relevant manual topic and uses exact localized labels. Existing skills and shared workflow resources remain included. Builds regenerate the bundle; CI checks freshness before building.

## Validation

Current-checkout checks passed: 19 focused server tests, 31 desktop runtime/SDK packaging tests, `pnpm docs:check`, skill validation, `git diff --check` and the server build used by `pnpm dev`. The inventory maps 28 routes and 16 settings. The i18n bundle contains 24,783 values across 11 locale files, including 6,893 entries each in English and German. The running Electron window was inspected on 26 October: current navigation, signed-in account and saved projects loaded successfully. Process working directories point to this checkout at `9c278ff02`, the renderer uses the standard development profile, and Vite serves `http://localhost:5173`. Automated checks cover route/settings mappings, page and translation parity, reference resolution, skill discovery, workspace refresh and preservation of custom skills. These checks do not prove every prose statement or live external account behavior. No mailbox connection or message sending was performed for the audit.

The development launcher also prepares the bundled Node runtime and OpenCode SDK needed by a fresh checkout. The standard testing profile and `http://localhost:5173` origin are preserved.

After removing both ignored translation outputs, the server test preload recreated them and all 19 focused server tests passed. A server build also recreated them from scratch. Copying only the compiled core bundle and generated translation module outside the repository preserved all 11 locales and 24,783 values, and the seeded German label lookup succeeded there.

## Help lookup and app links

Ordinary how-to requests load `legalwork-help` and directly read the matching topic through `legalwork_skill_read`. The skill no longer mandates an index, screen inventory, UI snapshot, account inspection or label lookup for each question. English labels are sufficient when no UI language is already known. Live diagnosis remains available when requested.

Manual topics include navigation-only `legalwork://app/...` links. The Markdown renderer opens supported destinations through the app router and preserves the current project for Settings. Links cannot invoke connection, send, delete or permission actions. All shipped links pass route checks, malformed/external/action links are rejected, and real renderer clicks verified Connectors, Recorder settings and Calendar. App typechecking passed. The final focused run passed 9 help/link tests, including reading the complete email topic through the actual skill-package reader in one response.
