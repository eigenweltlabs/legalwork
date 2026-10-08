# Gmail and Outlook agent plugins

The Plugins catalog contains separate Gmail and Outlook connections. Users sign
in through their system browser using LegalWork's installed-app registration;
they do not create OAuth clients or enter app secrets. These plugins query mail
on demand and do not depend on the full mail-client branch.

Each connected account can be enabled for individual local projects. Only the
local managed engine receives the mail-only runtime capability. Ordinary shared
client tokens cannot enumerate or use personal mail accounts. Remote projects
and externally managed engines are outside this first version.

Read-only sign-in is the default. Users can enable drafts and sending before
connecting or reconnecting. Gmail requests `gmail.readonly`, with
`gmail.compose` for draft/send access. Outlook requests `User.Read`,
`Mail.Read`, and the sign-in/refresh scopes, or `Mail.ReadWrite` and `Mail.Send`
for draft/send access. Outlook uses the `common` authority to support customer
tenants and personal Microsoft accounts. Actual granted scopes determine the
available actions.

The agent tools are `mail_list_accounts`, `mail_search`, `mail_read`,
`mail_download_attachment`, `mail_create_draft`, `mail_create_reply_draft`, and
`mail_send_email`. Use the provider/account IDs returned by discovery.
Attachments are downloaded into private working files in the task's project;
binary attachment bytes are not returned to the model. Outgoing email is plain
text. Outgoing attachments, sending existing drafts, and shared mailboxes are
not supported in this version.

Every send requires a host confirmation of the sender, To/Cc/Bcc, subject and
exact body, including when general server approvals are automatic. The confirmed
payload is immutable. Durable send receipts prevent repeated submission with
the same request ID, including after restart. Uncertain outcomes are never
retried automatically. Provider acceptance is not proof of delivery.

## Credentials and release packaging

The Outlook registration is `f7ae407e-0e9f-442d-a7e5-60cf8740992a` (LegalWork
Mail). It preserves the mail development callback and adds
`http://localhost/oauth/mail/outlook/callback`; the port varies at runtime.
It supports organizational and personal accounts, uses `eigenweltlabs.com` as
publisher domain, and references the LegalWork privacy and terms pages.

Gmail must use a Google **Desktop/installed-app** client. Never supply a
confidential Web application client secret to desktop packaging.
Google's installed-app client secret is non-confidential, and the packaged
client uses PKCE with a loopback callback. No user access or refresh tokens are
bundled.

For signed desktop release builds, configure the repository secrets
`LEGALWORK_GMAIL_PLUGIN_CLIENT_ID` and `LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET`.
The desktop build runs `build:mail-registration` and packages the installed
registration in `server/dist/mail-plugins/registration.json`. Without both
fields, Gmail sign-in stays unavailable and no stale registration is retained.
The signed release and alpha workflows pass these values into packaging.

For local review builds, `LEGALWORK_GMAIL_PLUGIN_DESKTOP_CONFIG` can point to a
private downloaded Google installed-client JSON when running:

```sh
pnpm --filter legalwork-server build
pnpm --filter legalwork-server build:mail-registration
```

Source-based development can use the corresponding Gmail client ID/secret
environment variables. Self-hosted instances can override the Outlook client
through `LEGALWORK_OUTLOOK_PLUGIN_CLIENT_ID`. These are operator settings,
not user onboarding fields.

Credential records, account information, project grants and content-free send
receipts are AES-256-GCM encrypted outside portable workspace settings.
The local key and vault are created with private file modes. File modes alone
do not provision Windows ACLs; the desktop profile's filesystem access and disk
encryption remain relevant. Downloads and chat histories are ordinary local
working files, not encrypted by this credential vault.

Disconnect removes local credentials and every project grant. Google revocation
is attempted and its outcome is reported. Microsoft users must separately
remove provider-side permissions through their account when desired.
Disconnecting does not erase original mail, local downloads or chat histories.

## Verification and live release gates

Microsoft Partner Center's verification summary shows completed contact and
identity checks. The remaining appeal requests an original paid domain
registration or renewal receipt for `eigenweltlabs.com`, showing the owner,
registrar, registration date and duration, and expiration at least two months
in the future. The account must finish that check before publisher verification
can be completed. Publisher verification does not override customer tenant
consent policies.

Google Cloud access requires account reauthentication. Confirm the production
project and installed client before setting release secrets. Declare the scopes
above, verify branding and public domains, and submit the scope justification
and a real end-to-end demonstration video. The video must show the OAuth client
ID, consent, read/draft/send features and the complete data flow, including the
selected model provider. A synthetic UI preview is development evidence and
does not replace that video or live provider acceptance. Restricted email data
can reach hosted models, so the assessment scope must include that server data
flow. Follow Google's instructions for the security assessment after its scope
review; no assessment contract or expenditure has been authorized here.

Use `https://eigenweltlabs.com/legalwork/privacy` for the privacy notice and
`https://eigenweltlabs.com/legalwork/terms` for terms. Search and reading access
requires `gmail.readonly`; draft creation and sending requires `gmail.compose`.
Explain why labels or the send-only scope cannot support these requested
features. The plugin does not request full mailbox modification/deletion,
Drive, Calendar, Contacts or domain-wide delegation.

Before public release, complete real Google and Microsoft consent and provider
acceptance with suitable test accounts, verify the installed registration in
signed macOS and Windows builds, and exercise refresh/reconnect/disconnect.
Do not send a live test message without authorization for its exact recipient.

## Development evidence

Run the API, authorization, token and send-recovery suites:

```sh
pnpm --dir apps/server exec bun test src/mail-plugins/mail-plugins.test.ts
pnpm --dir apps/server exec bun test src/mail-plugins/routes.e2e.test.ts
pnpm --filter legalwork-server typecheck
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app test:i18n
node --test apps/desktop/electron/host-approvals.test.mjs
```

The synthetic UI fixture is absent from production Vite inputs. Start the UI
development server and open `/mail-plugins-preview.html`; add `?lang=de` for
German. Its sign-in completion, cancellation, project grant and administrator
rejection controls use sample accounts only and never access real mail.
