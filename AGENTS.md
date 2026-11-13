# AGENTS.md

LegalWork helps users run agents, skills, and MCP. It is an open-source alternative to Claude Cowork/Codex as a desktop app.

## What LegalWork Is

LegalWork is a practical control surface for agentic work:

* Run local agent workflows from one place.
* Use OpenCode capabilities directly through LegalWork.
* Compose desktop app and server without lock-in.
* Treat the LegalWork app as a client of the LegalWork server API surface.
* Connect the app to a LegalWork server through its manual URL/token settings. Remote agent workspace registrations are retired; preserve legacy records as inactive configuration.

## Core Philosophy

* **Local-first, cloud-ready**: LegalWork runs on your machine in one click and can connect to cloud workflows when needed.
* **Server-consumption first**: the app should consume LegalWork server surfaces (self-hosted or hosted), not invent parallel behavior.
* **Composable**: use the desktop app or server mode based on the task.
* **Ejectable**: LegalWork is powered by OpenCode, so anything OpenCode can do is available in LegalWork, even before a dedicated UI exists.


## Pull Request Expectations (Fast Merge)

While developing, run the test that exercises the behavior you changed. Run
the relevant checks on the finished change before opening a PR and report the
commands and results. Reuse those results across commits that leave the tested
inputs unchanged. The merge gate owns platform matrices and package builds.
For a server runtime dependency change, also run
`node apps/desktop/scripts/check-server-deps.mjs`.

To maximize merge speed, include evidence of the end-to-end flow, subject to the screenshot and recording privacy rules below:

* Ideally: attach a short video/screen recording showing the flow running successfully.
* Otherwise: screenshots are acceptable, but video is preferred.

If you cannot run tests or capture the video, say so explicitly and explain why, and include the exact commands/steps for the reviewer to reproduce.

## Screenshot and Recording Privacy

* Do not commit, push, upload, or attach screenshots or screen recordings to LegalWork's repository, pull requests, issues, documentation, or shared artifacts without the user's explicit acknowledgement and approval of the exact media being shared.
* Screenshots and recordings must never contain real user or customer content, documents, chat messages, names, email addresses, case details, credentials, access tokens, or other personal, confidential, or sensitive information, even if the user approves sharing the media.
* Use only synthetic test data in an isolated demo or test environment. Inspect every image and recording before sharing; discard and retake any capture that contains sensitive content.
* If the user has not approved the media, provide text-only verification and reproduction steps.

## Coding Guidelines

### TypeScript

- Never use `any`, typecasts, or `as`, unless 100% necessary or specifically instructed.

### Package Managers

- Use pnpm.
- Never use npm or yarn.

### UI and UX

- Use components from @/components when possible.
- When creating new components, we prefer using shadcn/ui with (Base UI).
- Assume most end users of LegalWork are non-technical.

### User-facing help

- Keep the bundled manual in `docs/user-guide/` up to date in the same change whenever user-facing features, screens, settings, labels or behavior change.
- Write for questions users might ask: what a feature does, where to find it, how to set it up and use it, what prerequisites apply, and how to resolve common problems. Technical implementation notes do not replace this help.
- Give complete steps with the actual button and menu labels, including entry steps such as **Add > Plugins > select a connector**. Use supported app links to relevant pages and describe the current app directly.
- Cover new screens and settings in the guide and screen inventory mapping. Keep the `legalwork-help` skill's topic routing current so the agent can read the relevant page directly.
- After updating help or UI translations, run `pnpm docs:generate` and `pnpm docs:check`. Commit the source edits and any changes to `docs/user-guide/screens.json`. Git ignores the generated core skills bundle and translation copies. Keep user guides focused on using the app and put developer instructions in technical docs.

### Tech Stack Preferences

When uncertain, prefer: Tailwind, TypeScript, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod, Drizzle, Better-Auth.

### Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- Use the smallest possible diff to make a change. Then think of how to make it smaller and do that again.
- Avoid fallback expressions when types or control flow already guarantee a value.

### Prompt caching

- The system prompt must not change within a conversation: providers reuse their prompt cache only as far as a request matches the previous one from the start, so one changed line costs the cache for the whole conversation.
- `experimental.chat.system.transform` hooks add fixed text only. Live app state (open files, Office panes, project details, connections) goes into the conversation as a reminder via `app-state-reminders.ts`; per-turn context from the app goes into a hidden part of the user's message (`systemReminderPart`), never the prompt's `system` field.

### Workflow

- If asked to do too much work at once, stop and state that clearly.
