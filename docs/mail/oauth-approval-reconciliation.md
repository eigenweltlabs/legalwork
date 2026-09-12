# OAuth ownership and external approval gates — EIG-120

Scope-freeze reconciliation, 12 September 2026. EIG-120 is **not fully accepted**: dedicated development registrations and the local OAuth implementation exist, but the complete test-account matrix, enterprise scenarios and public approval work are unfinished. No new console login, registration, consent, mailbox operation or approval submission was performed for this reconciliation.

## Current implementation and ownership

The dated [registration record](registration-setup.md) identifies the LegalWork-owned Google project/Desktop client and Microsoft application created specifically for Mail. Their private configuration stays outside the repository. These resources are separate from existing Workspace integrations and other projects. Registration read-back proves configuration, not mailbox consent or production approval.

| Path | Current requested scopes and identity boundary |
|---|---|
| Gmail / Workspace | `openid`, `email`, `https://www.googleapis.com/auth/gmail.modify`; stable authenticated Google subject/profile binding. `gmail.modify` supports the full read/draft/send/label/trash surface and is restricted; immediate permanent deletion is excluded. |
| Personal Outlook / Hotmail | `openid profile offline_access User.Read Mail.ReadWrite Mail.Send`; only the `consumers` authority. `Mail.ReadWrite` does not itself authorize sending. |
| Configured Microsoft organization | The same base scopes, plus `Mail.ReadWrite.Shared` and `Mail.Send.Shared` in the current development configuration. Authority is pinned to the configured tenant. Shared mailbox access also requires actual Exchange permission; a declared capability or read access cannot grant send-as/on-behalf. |

Source of truth: `provider-config.ts`, `providers/development-config.ts`, `providers/connection-controller.ts`, `storage/graph-mailboxes.ts`. Organizational shared scopes are currently requested as part of the configured development flow, rather than an automatic later consent upgrade. Verify their granted values and tenant approval before advertising shared access. No application permissions or broad domain-wide mailbox access are requested. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Graph delegated permissions](https://learn.microsoft.com/en-us/graph/permissions-reference).

Authorization uses the system browser, fresh random state and S256 PKCE with an exact callback/verifier binding. Google listens on an OS-assigned IPv4 loopback port; Microsoft uses the registered `http://localhost/mail/callback` path with the actual listener port. Personal and organizational authority/identity remain bound during reconnect and refresh. Microsoft is a public native client with no client secret. The Google installed-client configuration is not proof of a confidential desktop identity. Refresh preserves an omitted refresh token, stores replacements atomically and fences reconnect/revocation against stale publication. The encrypted mail store owns usable account credentials; the renderer receives bounded status and account identity, not provider tokens. The OS keychain opens mail automatically under the existing preflight—no manual mail unlock/reset workflow is required. See [OAuth transport](oauth-foundation.md), [refresh handling](oauth-refresh.md) and [credential custody](credentials.md); the concrete implementation is `providers/oauth.ts` and `storage/credentials.ts`.

## Local and optional remote data flows

| User-visible operation | Data destination and approval relevance |
|---|---|
| Read/sync/search/drafts/outbox | Provider APIs ↔ local mail worker and encrypted store. Local search, MIME parsing and ordinary reading do not require a model. Sending and remote draft sync deliberately write to the provider. |
| Attachment → chat | Explicitly selected attachment is copied to the chosen workspace and added to an unsent draft with scoped source-return metadata. A later user send can place that material in the workspace's configured model request. |
| Granted workspace mail tools | An explicit account/matter grant can return scoped mail to an agent; returned content enters that task and may reach its configured remote model. Matter authorization is independently checked. Personal account access is not implied by a workspace or a generic storage receipt. |
| Save to connected storage | Explicit originals/attachments pass through the shared storage interface to the selected writable connection. Provider credentials stay server-owned. The other storage PRs remain dependencies; the Mail interface alone does not certify all remote stores. |
| Matter filing / ingestion | An independently authorized matter workflow can retain MIME/attachments and submit scoped ingestion to LegalMemory. Its backend draft PR remains a separate deployment dependency. Generic storage saves do not fabricate matter authority. |
| Export / encrypted backup | User-selected filesystem destinations; exported readable files and earlier backups have independent retention. Account disconnect removes usable credentials but retains locked encrypted local originals until explicit deletion. |

This product has optional server/model transfer capabilities, so its public review cannot be represented simply as a local-only email viewer. Google's current guidance requires restricted-scope verification unless an applicable exception is established; access through third-party servers also triggers assessment requirements. The project owner must submit the actual deployment/data-flow description and obtain the applicable review decision. No local-only exception or completed assessment is claimed. [Restricted-scope review and assessment](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Exact acceptance disposition

| Original criterion | Completed local evidence | Remaining external requirement |
|---|---|---|
| Minimum scopes, PKCE/refresh, redirects, ownership; Gmail/Workspace, Microsoft365 and Outlook test accounts | Documented above; dedicated registrations, synthetic callback/refresh/credential isolation evidence. Workspace has a successful read-only live comparison. | Complete existing Outlook verification; establish licensed Microsoft365 test mailbox and a controlled synthetic dataset. Consumer Gmail needs separate coverage if separately advertised. |
| Enterprise IMAP disabled, shared mailbox, send-as/on-behalf, revoked access, administrator consent | Graph/shared identity and denial/revocation guards exist with synthetic tests. | Named tenant/admin contact, Exchange-licensed test user with IMAP disabled, shared/delegated mailbox, separately specified SendAs/on-behalf rights, and coordinated consent/revocation scenarios. No new permissions are inferred from successful reads. |
| Start applicable Google verification/enterprise consent, map local versus remote AI before assessment | Dedicated External/Testing Google branding and scopes were configured; current data flows are mapped above. | No public verification submission ID, assessment decision or completed enterprise consent is recorded. Owner must select deployment/audience, review policy/brand/data flows and initiate the appropriate existing-project review. Development registration is not that submission. |
| External approval owners and lead-time risks, no borrowed credentials | Ownership and handoff below recorded; separate Mail registrations retained. | Confirm the actual tenant administrator and any assessment/legal-review contacts. No provider approval date can be promised. |

The [live-provider record](live-provider-qualification.md) remains authoritative: Workspace read-only comparison at `aa2dd5d8b` matched 609 identities, 14 labels, all message memberships and sampled 10 originals/10 bodies/17 attachments on macOS arm64. It does not establish live sends, expiry/revocation, all platforms or any other provider. Existing Outlook verification belongs to the lead; do not start a competing sign-in. iCloud and standards-provider inputs are listed separately in [EIG-135](standards-provider-matrix.md).

## Approval handoff and release gate

| Owner | Concrete next input / action | Lead-time risk |
|---|---|---|
| Chris Poensgen / LegalWork project owner | Confirm distribution audience and the current dedicated project's branding/contact/domain ownership; approve accurate local/remote data flows and the review submission. | Provider review can request additional evidence; no submission or approval date is recorded. |
| Pilot Microsoft365 tenant administrator — not yet supplied | Provide tenant/contact, licensed mailbox, consent policy and controlled shared permissions; coordinate denied consent/revocation and IMAP-disabled cases. | Licensing, Conditional Access, consent policy and administrative scheduling are external dependencies. |
| Account owners / lead | Finish the existing Outlook verification and supply credentials only in approved local Settings; designate synthetic test data and controlled sender/recipient addresses before outbound or mutation exercises. | Account verification/app-password eligibility and user availability are not implementation completion. |
| LegalWork privacy/release owner, with qualified review contact if required | Review the concrete English/German retention correction in [retention and recovery](retention-and-recovery.md#public-notice-correction--review-draft-not-published) and publish it through the normal website process before release. | The currently recorded public-notice deletion-on-disconnect promise conflicts with retained local mail. This draft is not publication or legal approval. |
| Google verification team / approved assessor if applicable | Decide the submitted application's verification/assessment requirements and review evidence; the project owner handles correspondence. | External scope/brand/security review and recurring obligations cannot be replaced by synthetic tests. |

These remaining steps need mailbox-owner, tenant-administrator or release-owner input. No new authentication, publication or provider mutation attempt was performed for this reconciliation; no credentials were read or printed and no notice was deployed. Registration metadata and synthetic passes do not satisfy the remaining external acceptance criteria.
