# Assistant settings and cloud setup

14 October 2026. Desktop PR #232 adds **Settings → Your assistant**, with name,
avatar, desktop notifications, a link to model settings, and cloud access.
The existing assistant-avatar editor keeps its quick controls and uses the
same cloud setup component.

**Enable cloud assistant** opens the setup modal and starts the existing server
setup flow. The chosen avatar animates inside an orbit, with real preparation
and startup stages. Closing the modal leaves setup running while LegalWork
remains open. Reopening reads progress without starting another setup.
Readiness is independent of background file transfers. Errors have explicit
status checking and retry controls; signed-out users can open Account settings.
Motion respects the reduced-motion preference.

## Validation

- App tests: 936 passed, zero failures.
- App TypeScript check passed.
- Translation validation passed: 5,696 keys in English and German.
- Actual React components and HTTP client were exercised in headless Chromium
  with controlled API responses. Activation, preparation/start/readiness,
  closing/reopening, profile saving, model-settings navigation, retry, disabling
  and signed-out navigation passed.
- A slow or lost activation response did not block independently observed
  readiness or create a duplicate setup request. Ready state rendered with
  twelve projects still pending. Narrow-window and reduced-motion checks passed.

These are UI contract checks with synthetic data. No real account, VM, payment
or production service was changed. This does not claim improved VM startup
latency or a new live staging activation test. Account switching and session
ownership remain separate work on the running todo list.

## Review and reproduce

Use this branch with the isolated staging desktop profile and staging API.
Open **Settings → Your assistant**, change and save the name/avatar, then use
**Enable cloud assistant**. Check the displayed account, close and reopen the
progress modal, and verify readiness while bulk sync continues. The same
button/modal is available from the assistant-avatar editor. With no connected
account, the modal links to Account settings. Verify light/dark themes,
keyboard dismissal and reduced motion.

- [Settings](settings-light.png)
- [Setup progress](progress-light.png)
- [Ready with background sync in dark mode](ready-dark.png)
- [Failure and retry at 390 pixels](error-narrow.png)
- [Setup animation and stage transitions](cloud-assistant-setup.webm)
- [UI contract results](verification.txt)
