# Direct Microsoft sign-in

Outlook Email, Outlook Calendar, OneDrive for work or school, OneDrive Personal
and SharePoint use LegalWork's Microsoft desktop registration by default. Users
choose Connect and sign in to Microsoft in their browser. No Eigenwelt login,
Nango integration or client-secret configuration is needed for these connections.

## Registration and token storage

- Public client ID: `d3a9a5d6-889f-4ee2-a0f0-781ddf14d0b7`.
- Platform: Mobile and desktop applications.
- Registered callback: `http://localhost:53683/callback`.
- Audience: work/school and personal Microsoft accounts. Outlook uses `common`,
  business OneDrive and SharePoint use `organizations`, and personal OneDrive
  uses `consumers`.
- Authorization codes use S256 PKCE and random state. The existing LegalWork
  server exchanges and refreshes tokens directly with Microsoft. Client secrets
  are neither included in the app nor sent by this native client flow.
- Tokens remain in the existing encrypted local OAuth vault. The renderer and
  tools receive account handles, not tokens. Only the server owner can manage
  these personal connections.

The public client ID is not a secret. The existing callback listener runs on the
LegalWork server's loopback interface. Normal desktop use keeps the server and
browser on the same machine; this PR does not add remote callback forwarding.

Reads are enabled first. Mail/calendar/file writes remain independently disabled
until the user enables them and reconnects to consent to the additional scopes.
Outlook mail and calendar share a sign-in while retaining separate activation and
write settings. SharePoint also requires the user to choose a document library.

Connection details retain an advanced own-app override. Saved custom clients are
not overwritten. Resetting a custom Microsoft app disconnects its accounts and
restores LegalWork's default. Existing managed accounts keep their original
reconnect method; users disconnect them before starting a new direct sign-in.

Microsoft publisher verification and customer tenant consent policies still
apply. Business verification must finish before the verified-publisher badge can
be added. Some organizations require their administrator to approve consent.
Uploading company documents alone does not approve the app or grant data access.

## Automated checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter legalwork-server exec bun test src/connectors src/file-storage/oauth
pnpm --filter @legalwork/app exec bun test tests/connector-status-client.test.ts tests/storage-cloud-setup.test.tsx tests/firm-connector-details.test.tsx
pnpm --filter legalwork-server typecheck
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app test:i18n
```

The Microsoft fixtures check all five connectors without saving a custom app,
the expected account authorities, callback and PKCE, direct token refresh,
native Graph connection tests, encrypted storage, disconnect, custom overrides,
owner-only routes and read-only mode. Provider APIs and consent are simulated;
these checks do not prove that a real tenant has approved the registration.

## Reproduce the UI flow without a Microsoft account

Run these in separate terminals from the repository root:

```sh
LEGALWORK_CONNECTOR_PREVIEW_SIGNED_OUT=1 pnpm --filter legalwork-server exec bun scripts/connector-preview.ts
pnpm --filter @legalwork/app exec vite --host 127.0.0.1 --port 44643 --strictPort
```

Open `http://127.0.0.1:44643/connectors-preview.html?provider=outlook`.
Connect without entering credentials, choose Complete simulated sign-in, then
Test connection. Outlook Calendar should show the same account and offer its
separate Activate action. Repeat with each Microsoft storage provider. The
fixture uses isolated temporary state and never opens real Microsoft consent.

## Live read-only smoke test before rollout

1. In the normal desktop app, connect Outlook with a consenting test account.
   Confirm Microsoft's consent screen names the LegalWork registration and only
   requests read permissions plus offline access.
2. Test the connection, list a small number of messages, activate Calendar and
   list events in a narrow date range. Do not send mail or create events.
3. Connect business OneDrive, personal OneDrive and SharePoint with suitable
   licensed accounts. For SharePoint, choose a site and document library. List
   files and open a disposable fixture document without changing its contents.
4. Restart LegalWork and verify reads still work, then disconnect and verify
   that subsequent access requires sign-in again. Exercise refresh with an
   expired test token through the provider's supported test workflow.
5. Cancel sign-in and deny consent in separate attempts; no new account should
   activate. Treat admin-consent or publisher-verification prompts as pending
   external prerequisites, not successful sign-in.

References: [Microsoft authorization code flow and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview).
