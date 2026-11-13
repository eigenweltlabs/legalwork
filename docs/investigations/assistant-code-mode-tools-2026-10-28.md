# Assistant Code Mode tool audit

Audited the Assistant's 32 registered tools, local plugin registration and filtering, native execution hooks, and chat result rendering on 28 October 2026.

## Findings and fixes

### Six tools were excluded from Code Mode

`legalwork-assistant-tools.ts` put the following tools in `directInteractionTools` with `codemode: false`:

| Tool | Effect of calling it through `execute` |
| --- | --- |
| `legalwork_assistant_react` | Unknown tool, no chat-bubble reaction |
| `legalwork_assistant_set_name` | Unknown tool, name not saved and no appearance picker |
| `legalwork_assistant_share_file` | Unknown tool, no deliverable card |
| `legalwork_assistant_delegate` | Unknown tool, project work not dispatched |
| `legalwork_assistant_attention_present` | Unknown tool, required approval or question card not presented |
| `legalwork_assistant_attention_answer` | Unknown tool, user's answer not relayed |

This exclusion was introduced in `cf187096` (Complete Assistant reports, interactions and messenger refinements). The code comment explains its purpose: preserve individual UI results when a Code Mode script summarizes or discards a return value. It made the tools direct-only instead of fixing result delivery. The reaction instructions then explicitly prohibited Code Mode, while the failing model still used it. Starring an email was an incorrect substitution for the failed reaction, not the intended behavior of the reaction tool.

All 32 Assistant tools now explicitly participate in Code Mode. Reaction and naming signatures are pinned in its catalog so the model does not need a preliminary search for first-action reactions or setup. Native permission identities, scoped delegation credentials, project access checks, and request validation remain in place.

### Reaction validation assumed live progress was persisted

Simply making `react` callable was insufficient. The first attempted Code Mode fix checked `metadata.toolCalls` in stored chat history. The released engine publishes running nested calls as transient progress events and only includes their final metadata in the completed outer tool. The route therefore rejected a valid first reaction with `reaction_too_late`.

The execution hook now checks actual nested-call order within each session/message/tool execution. The route separately verifies the current human message, rejects automated turns and previous prose/work, and requires the sole outer Code Mode call to be running. No JavaScript-source parsing or model-supplied claim is used as evidence that the reaction tool ran.

### UI results depended on the script's returned text

The previous chat projection could recover a card only if the script returned a recognizable payload. A successful call followed by `return "done"` lost its card.

The native completion hook now records schema-validated results in the outer execution's metadata. The chat uses those actual results, including after a later script error, rather than trusting the script's final text. This covers reactions, naming, shared files and delegation cards, plus the existing supported review, calculation, email/calendar draft, schedule, task, project, wiki and view widgets. Attention presentation and answers already update server state and notify the UI independently of returned text; they do not need an extra chat card.

New execution records do not promote fabricated returned JSON into a card. Failed calls do not become successful-looking widgets. An unconfirmed delegation keeps its existing warning card. Already-saved messages without the new metadata retain their existing presentation.

### Renaming could return a default profile

An existing Assistant without an onboarding row saved a new name correctly but returned `name: null` and the default appearance from `onboarding()`. The completed state now uses the saved profile. First-use naming still returns the appearance-selection step; later renaming preserves the current icon.

## Other audited tools

The remaining 26 Assistant tools already used normal Code Mode registration:

- Memory and reporting: `scratchpad`, `briefing`, `save_report`.
- Session coordination: `follow_up`, `session_control`, `attention`, `history`, `session_search`, `session_status`.
- Recordings: `recordings`, `recording_read`, `recording_rename`, `recording_project`, `recording_delete`, `recorder`.
- Projects: `projects`, `project_overview`, `project_create`, `project_details`, `project_set_metadata`, `project_list`, `project_read`.
- Other records: `tasks`, `calendar`, `calendar_read`, `file_search`.

Every name above has the `legalwork_assistant_` prefix. Registration tests now check Code Mode exposure and the unchanged permission name for the complete Assistant tool set.

The only other production `codemode: false` registration found under `apps`, `packages` and `scripts` is `legalwork_review_submit`. It is a private review-worker completion tool. Its context hook removes it from ordinary sessions and gives the authorized review worker exactly that direct tool with the server-issued output schema. This is intentional, not an Assistant capability gap.

Browser tools remain deliberately restricted to the configured browser subagent. Project access, subscriptions, user-disabled connectors and native deny policies can still restrict tools. In particular, a native deny policy removes a tool from the Code Mode inventory, so a forced call can still report Unknown tool. The fix does not bypass those policies. This audit does not certify external connectors or provider-specific model behavior.

## Verification

- Released-engine integration tests call reactions through normal Code Mode, both returning and discarding the result, and after a later script exception. They reject a reaction following another tool and verify a native deny policy prevents execution.
- Released-engine tests save the Assistant's name, verify the stored profile, and retain file and naming cards from a discarded script result.
- Released-engine tests invoke delegation, attention presentation and answer tools through Code Mode with deliberately invalid targets. They reach their domain/access checks rather than failing tool lookup. Existing route tests cover live attention details, stale replies and delegated delivery.
- Hook tests cover mixed results, reverse completion order, duplicate prevention, failed/fabricated results and separate simultaneous sessions.
- Renderer tests verify a heart on the user bubble and restoration of supported cards in both live projection and saved history.
- A profile regression test verifies renaming without an onboarding row across a service restart.

Tests use temporary runtime data and a controlled local model endpoint. They do not rename the user's Assistant, touch emails, or use the normal development profile.

Validation result: 44 server tests and 65 renderer tests passed (109 total). Server and app TypeScript checks, generated-help verification and `git diff --check` passed.
