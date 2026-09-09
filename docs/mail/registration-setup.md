# Fresh Legalwork Mail development registrations

EIG-120 remains **incomplete**: the new Microsoft development app and Google Desktop OAuth client/project/Gmail API are created and verified. Provider consent, dedicated test mailboxes and live acceptance remain open. Do not reuse or modify existing Google Workspace registrations. Updated 9 September 2026.

## Verified development setup

The lead ran the new-registration Azure script and verified the dedicated application by reading it back. It has a native loopback redirect and delegated permissions only, with no client secret or consent grant. This does not establish Exchange licensing, mailbox access or successful OAuth consent. Non-secret operational identifiers and verification evidence are maintained in [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120).

After the owner reauthenticated Google CLI, the lead created `legalwork-mail-dev-20260909` (Legalwork Mail Development) under the same organization as the existing training project, verified ACTIVE status and enabled `gmail.googleapis.com`. No billing attachment or compute deployment was made. The training project was read only to identify its organization; it was not changed.

The owner then authorized browser control, signed in to Google Cloud and explicitly approved Google API Services User Data Policy acceptance and client creation. The lead created **Legalwork Mail Development Desktop**, verified its Desktop type and Enabled state, and saved the displayed credentials into a standard installed-client JSON outside the repository. The in-app browser's download did not produce a file; the local copy was verified by JSON parsing and non-secret client/project identity only. Its directory is private (0700), its file 0600. Operational IDs and current state are in EIG-120; no secret is in source or Linear. Audience is External/Testing with the owner as the sole tester. Existing Legalwork homepage/privacy links and Eigenwelt's domain are configured. No mailbox consent or live mail request has occurred.

Before pilot/production, reconcile the published privacy notice's deletion-on-disconnect wording with `scope.md`'s retained locked archive and explicit purge contract. EIG-151 tracks this concrete mismatch; registration setup does not change the public legal notice or the approved mail retention contract.

## Azure: executable plan, then explicit apply

Prerequisites: Bun, Azure CLI, approved owning account and explicit tenant, permission to register apps, and dedicated licensed Exchange test users. The lead establishes CLI authentication separately after confirming ownership. This script never logs in or switches tenants/subscriptions. A subscription is not the app-registration ownership boundary; the Entra tenant is.

Run from the repository root, substituting the approved tenant and a unique dedicated suffix:

```sh
pnpm exec bun scripts/mail/registration-azure.mjs --tenant TENANT_GUID --name legalwork-mail-dev-SUFFIX
```

Suffix must be lowercase letters, digits or hyphens. Default is dry-run: it reads active account metadata, searches the dedicated app name, resolves enabled delegated scope IDs from Microsoft's Graph service principal, and prints the proposed configuration. It makes authenticated read requests and performs no writes until `--apply`.

Once the owner/tenant and displayed plan are established, the lead runs the same command with `--apply`. This uses `az rest` with Graph's `POST /applications` JSON surface; the high-level `az ad app create` command does not support the ownership-description field. The one creation request includes the dedicated name, ownership marker, single-tenant audience, native/public desktop redirect `http://localhost/mail/callback` and delegated `openid`, `profile`, `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`. Runtime uses the same callback path with the actual local listener port. The app receives no client secret; fallback public-client flows are disabled because the native redirect identifies the public client for interactive authorization code + S256 PKCE. No implicit/password/device-code flow is provisioned. [Create application](https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0), [native registration](https://learn.microsoft.com/en-us/graph/auth-register-app-v2), [localhost port matching](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

The script resolves permission IDs instead of copying unverified UUIDs, then checks the created object by ID: exact dedicated name/marker, audience, one native redirect, no Web/SPA redirects, no credentials, and exact delegated permission set. It prints only object/client identifiers and status; it does not grant consent. The lead must establish tenant consent policy and approve required delegated permissions separately. [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

Idempotency is conservative: one exact name with the script's ownership marker is verified and reused without mutation; a foreign name collision, duplicates, or configuration drift stop execution. There is no update/repair operation. Run serially: directory display names are not unique and Azure has no atomic create-if-name-absent guarantee. If creation succeeds but read-back fails because of replication lag, retry after checking the dedicated app by name; never invent a second name just to bypass an ambiguous outcome. A read-back mismatch never triggers automatic deletion.

Rollback is manual and limited to the new application. Record the successful output's object ID. In the approved tenant, run `az ad app show --id OBJECT_ID --query '{id:id,appId:appId,displayName:displayName,description:description}'` and verify the dedicated name plus marker `Legalwork Mail development registration; managed by registration-azure.mjs v1`. Then, if rollback is intended, run `az ad app delete --id OBJECT_ID`. Never delete by a guessed name or an existing Workspace client ID. Review any subsequently created enterprise-app consent/service-principal state separately; this script creates neither a service principal nor consent grants. [Show/delete commands](https://learn.microsoft.com/en-us/cli/azure/ad/app?view=azure-cli-latest).

## Google: dedicated project and supported console step

No documented public `gcloud` command or public API for creating the standard Google Auth Platform **Desktop app** OAuth client was verified. Do not substitute `gcloud iam oauth-clients create`: its documented IAM OAuth integration is for workforce identity/Identity-Aware Proxy and cloud-platform scopes, not ordinary consumer/Workspace Gmail installed-app clients. Likewise, an IAP OAuth client is not a Gmail Desktop client. [IAM OAuth integration boundary](https://docs.cloud.google.com/iam/docs/workforce-manage-oauth-app), [IAM command](https://docs.cloud.google.com/sdk/gcloud/reference/iam/oauth-clients/create).

The minimal supported manual path is:

1. Select the dedicated development project `legalwork-mail-dev-20260909`; project creation and Gmail API enablement are complete. For a separate deployment, create a fresh owned project and enable the API with `gcloud services enable gmail.googleapis.com --project NEW_PROJECT_ID`. Do not change `eigenweltlabs-training`.
2. In that project, Google Auth Platform → Branding: configure the application name `Legalwork Mail Development`, support email and developer contact. Set Audience intentionally: Internal for organization-only testing or External in Testing with each dedicated test user's email listed. Data Access: request Gmail modify and the identity scopes actually used by the mail connection.
3. Google Auth Platform → Clients → Create client → **Desktop app** → name `Legalwork Mail Development Desktop` → Create. Download the installed-client JSON immediately into an owner-controlled location outside the repository; client secrets are shown/downloadable at creation. Do not paste it into task output. This console step cannot honestly be represented by the IAM CLI above. [Official Desktop credential steps](https://developers.google.com/workspace/guides/create-credentials), [client management/download behavior](https://support.google.com/cloud/answer/15549257?hl=en), [consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent).
4. Supply this new client only to the new mail connection configuration once integration supports that separation. Do not overwrite existing Workspace OAuth environment settings. Verify project/client identity through redacted metadata, enable API access under Workspace policy, and complete consent with dedicated synthetic-data accounts. Desktop redirect is an actual loopback listener such as `http://127.0.0.1:<port>/`; use S256 PKCE and state. [Installed-app flow](https://developers.google.com/identity/protocols/oauth2/native-app).

Google rollback: select the **new project's new Desktop client** in Clients and delete that client after verifying its ID/name; remove local test credentials. Keep project deletion a separate deliberate operation because it deletes all project resources. Never delete or rotate existing Workspace credentials as rollback.

## Capability and acceptance boundaries

Single-tenant Graph is a development rollout constraint, not the product definition. Outlook.com personal accounts and Microsoft organizational multitenant support remain core planned mail capabilities. They need explicit audience/authority policy, registration support and tests; the current provider-config validator must be extended accordingly rather than treating those accounts as unsupported product scope.

`gmail.modify` does not allow immediate permanent deletion that bypasses Trash. The product contract must distinguish Move to Trash from permanent deletion and report the latter unavailable under this grant. Do not silently claim complete deletion support or broaden to `https://mail.google.com/`. [Gmail scope boundary](https://developers.google.com/workspace/gmail/api/auth/scopes).

Registration is not live acceptance. Next evidence remains actual consent/granted scopes, isolated account identity, refresh after restart and revocation, synthetic message sync/mutations, and explicitly authorized controlled sends. See `provider-readiness.md` for test-account prerequisites. Mock tests validate script command intent and safety checks; actual Azure creation/read-back and Google project/API state were verified separately. OAuth interoperability remains untested.

## Personal Microsoft account extension (2026-09-09)

The lead updated and read back the dedicated development registration `f7ae407e-0e9f-442d-a7e5-60cf8740992a`: `signInAudience=AzureADandPersonalMicrosoftAccount`, `api.requestedAccessTokenVersion=2`, the existing `http://localhost/mail/callback`, and zero password/key credentials. No consent grants were added. The provisioning helper now accepts explicit `--audience organizational-and-personal` to create/verify that exact policy; its default remains organizational, and it refuses unmanaged registrations, arbitrary audiences, incorrect token versions or drift without mutation. Use the explicit flag when verifying this updated registration. Microsoft requires access-token version 2 for personal-account audiences. [API application resource](https://learn.microsoft.com/en-us/graph/api/resources/apiapplication?view=graph-rest-1.0), [application update](https://learn.microsoft.com/en-us/graph/api/application-update?view=graph-rest-1.0).

The runtime now supports personal `consumers` and the explicitly configured organizational tenant as separate paths, as described in [onboarding.md](onboarding.md). The earlier single-tenant runtime limitation above is superseded. Broad `common`/organizational multitenant discovery is not enabled. Registration read-back is not consent or live mailbox qualification.
