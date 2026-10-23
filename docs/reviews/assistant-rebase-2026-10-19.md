# Assistant rebase verification — 19 October 2026

`codex/legalwork-cloud-sync` is based on current `dev` (`e3900fa4`). Model API's
`codex/assistant-channel-integration` is based on `main` (`b2892ed`). Existing
assistant commit history is retained, including its merge commits. Local recovery
refs retain both original branch heads.

Conflict resolution preserves native Nango connectors, email/calendar draft cards,
wiki access checks, shared message queues, document editing in the background,
firm policy/sandbox checks, the neutral Assistant settings icon and activation UI.
The managed engine starts after the LegalWork server binds its actual port, and
cloud execution keeps its lease/checkpoint fences. Private preference imports
retain their original edit timestamp; schema values go through the bundled server
schema module. Scheduling respects the restored VM's explicit TZ even after Bun
has cached its earlier default zone.

The unrelated pre-existing calendar generated-code edit was set aside before the
rebase and restored byte-for-byte afterward; it is not part of this change.

## Validation

- App and server TypeScript checks passed; server build passed.
- i18n validation: 6,906 keys in English/German, complete.
- 73 focused server tests passed, covering private replicas, connector/browser
  policy, Assistant CRUD, packaged imports and document UI boundaries.
- 10 message/Assistant rendering tests, 4 scheduling tests and 8 Electron
  notification/recorder/signing tests passed. Electron entry/build script syntax
  checks passed.
- App suite: 1,612 passed; 3 Lexical initialization errors remain. The same errors
  reproduce from an unchanged `dev` source archive using the same dependencies
  (1,570 passed). No app assertion failures remain after resolving the integration.
- Full server suite: 2,487 passed, 48 skipped and two unchanged `dev` failures
  concern a streaming-response error test and wiki file-watcher timing. Both
  reproduce in the unchanged base, including as isolated test files.

Tests use local fixtures and mocked provider calls. No staging deployment, VM image
rebuild, new live OAuth consent or native iOS round trip is claimed by this rebase.
Connector sharing with the cloud worker remains a proposal in Model API's
`docs/assistant-connector-sync-proposal.md`; OAuth vaults remain excluded from sync.
