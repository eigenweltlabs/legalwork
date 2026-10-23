# Assistant history across desktop and cloud

Mobile messages execute in the cloud. Desktop messages still execute locally. The history projection connects their visible conversations without replaying a phone prompt as local work or replacing either OpenCode database.

When cloud setup is enabled for the current Eigenwelt account, the desktop publishes completed user and assistant text bubbles to `POST /api/desktop/assistant/history`. The platform uses the account's existing iOS conversation, stamps a stable installation/message origin and suppresses runtime dispatch for this authenticated history path. Ordinary mobile publications, including desktop-looking client idempotency keys, still create cloud work. Hidden reminders, reasoning and tool output are excluded. Assistant replies to synthetic local delegated-result notifications are mirrored, without their model-only source text.

`GET /api/desktop/assistant/history` reads the existing owner/org channel journal. A separate local SQLite projection stores account-scoped events, cursors and settlement markers. It survives restarts and lost responses; the signed-in account is checked around each network operation. Each page also lists current active conversations, so revoked bindings remove their cached bubbles. An expired upstream cursor clears only that account's cached projection before reloading retained history. Cloud live reactions, acknowledgements and typing arrive through this projection while work continues.

The Main Assistant UI merges projected bubbles with native messages by their stable IDs and local calendar dates. Local echoes keep the engine's original IDs. Imported bubbles cannot edit, fork or revert local engine work. Cloud-only older dates are rendered without creating an engine session. This read model never seeds the engine transcript or prompt queue.

Incoming history is pulled before outgoing backfill. At most ten completed desktop bubbles are published per cycle. Today's and yesterday's sessions stay fresh; older sessions are scanned gradually, including message pagination. Text bubbles are limited by the channel protocol to 65,536 characters. Channel attachment names are displayed; this projection does not add attachment download/file-card mapping. Project file replication is handled by the existing sync layer.

`/assistant/channel-context` supplies a bounded hidden per-turn reminder through the assistant plugin. Historical text is JSON source data with escaped markup, explicitly untrusted and already handled; it grants no permissions and never becomes a new request. Only desktop history or server-derived settled cloud turns enter this context. A live acknowledgement alone does not mark work complete. In the VM, only completed desktop-origin history missing from the current engine context is supplemental. The system prompt stays fixed.

Automatic delegated results arriving in the VM after their original channel job has completed still require a separate durable continuation correlation and forwarding path. The active-turn live protocol and desktop mirroring do not solve that gap.

Validation:

```sh
pnpm --filter legalwork-server exec bun test src/assistant-channel-history.test.ts src/opencode-plugins/legalwork-assistant-tools.test.ts src/channel-runtime.test.ts src/channel-live-events.test.ts
pnpm --filter @legalwork/app exec bun test tests/assistant-channel-transcript.test.ts tests/assistant-bubbles.test.ts tests/assistant-chat-presentation.test.tsx
pnpm --filter legalwork-server typecheck
pnpm --filter @legalwork/app typecheck
```

Replay/restart, current account isolation, account changes during requests, retention reset, typing expiry, settled context, hidden text filtering and no local prompt execution are covered by these tests. Model API history/dispatch integration tests run against a separate development PostgreSQL database.
