# Personal connector sync — 19 October 2026

Native Nango connection references are registered with Model API when Cloud
assistant is enabled. The existing credential vault, project/file sync and native
provider adapters are retained. Registry invalidations use the existing sync SSE.
No OAuth vault, refresh token, Nango service key, mailbox or provider data is copied
as part of VM startup.

Settings → Integrations → the native connector now has a Cloud assistant access
switch separate from desktop write access. Initial cloud permissions are read-only;
Outlook mail/calendar activation remains independent. Own-app OAuth and arbitrary
MCP credentials remain on the device, as shown in the settings text.

Tests cover adoption, fresh VM discovery with one registry fetch, native Gmail
requests using opaque bindings, request coalescing, read-only defaults, independent
Outlook activation, cloud disable with an already prepared request, tombstones,
account switching, late old-owner responses, outages, local-account conflicts and
worker permission escalation. Provider responses are simulated; no live account
or simulator session has been used for acceptance of this change.

The companion Model API branch is `codex/assistant-channel-integration` (PR #87).
Apply its migration 0052 and API first, then deploy this LegalWork version in both
the desktop and the guest image. Existing guests need their LegalWork runtime
updated; old disk images do not discover the new registry automatically. See
`model-api/docs/assistant-connector-sync.md` for the full deployment order and
remaining credential-sharing scope.

Verification commands:

- `pnpm --dir apps/server typecheck` and `pnpm --dir apps/app typecheck` — pass.
- `pnpm --dir apps/server exec bun test src/connectors src/eigenwelt-sync-events.test.ts src/app-sync-events.test.ts src/cloud-assistant-setup.test.ts src/bundled-connector-imports.test.ts` — pass.
- `pnpm --dir apps/server build` — pass; the existing local calculator edit was preserved.
- `pnpm --dir apps/app test:i18n` — 6,910 English/German keys complete.
- Companion platform: unit suite, full integration suite (526 passed, two skipped),
  typecheck and Drizzle generation with no schema drift. Integration tests use a
  fresh disposable database, including upgrade paths through migration 0051.
